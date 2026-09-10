import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { env } from "@/server/env";

const execFileAsync = promisify(execFile);

export interface MediaProbe {
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  sampleRate: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoDuration?: number;
  videoStart?: number;
  codec?: string;
}

export interface FinalMediaQc {
  passed: boolean;
  probe: MediaProbe;
  blackFrameSegments: number;
  audioMaxVolumeDb: number | null;
  audioClipping: boolean;
  expectedResolution: string;
  issues: string[];
}

export function canStreamCopyVideo(probe: Pick<MediaProbe, "width" | "height" | "frameRate">, resolution: "720p" | "1080p" | "4k"): boolean {
  const [targetWidth, targetHeight] = (resolution === "4k" ? "3840:2160" : resolution === "1080p" ? "1920:1080" : "1280:720").split(":").map(Number);
  return probe.width === targetWidth && probe.height === targetHeight && Math.abs(probe.frameRate - 24) <= 0.01;
}

export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const { stdout } = await execFileAsync(env().FFPROBE_PATH, [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", filePath,
  ], { maxBuffer: 8 * 1024 * 1024, timeout: 60_000, windowsHide: true });
  const payload = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; duration?: string; start_time?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string }>;
    format?: { duration?: string };
  };
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  const audio = payload.streams?.find((stream) => stream.codec_type === "audio");
  return {
    duration: Number(payload.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    frameRate: parseRate(video?.r_frame_rate),
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoDuration: video?.duration ? Number(video.duration) : undefined,
    videoStart: Number(video?.start_time ?? 0),
    codec: video?.codec_name,
  };
}

export async function validateGeneratedShot(video: Uint8Array, expectedDurationSeconds: number): Promise<MediaProbe> {
  const tempRoot = path.join(os.tmpdir(), `cineforge-shot-validation-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    const source = path.join(tempRoot, "shot.mp4");
    await writeFile(source, video);
    let probe: MediaProbe;
    try {
      probe = await probeMedia(source);
    } catch (error) {
      throw Object.assign(new Error(`Invalid media: ffprobe could not read the generated shot (${error instanceof Error ? error.message : String(error)}).`), { code: "CORRUPTED_RESULT" });
    }
    if (!probe.hasVideo || !Number.isFinite(probe.duration) || probe.duration <= 0) {
      throw Object.assign(new Error("Invalid media: generated shot has no readable video stream."), { code: "CORRUPTED_RESULT" });
    }
    if (!probe.hasAudio) {
      throw Object.assign(new Error("Invalid media: generated shot has no isolated audio stream."), { code: "CORRUPTED_RESULT" });
    }
    const tolerance = Math.max(0.25, expectedDurationSeconds * 0.04);
    if (probe.duration + tolerance < expectedDurationSeconds) {
      throw Object.assign(new Error(`Invalid media: generated shot is ${probe.duration.toFixed(2)}s but at least ${expectedDurationSeconds.toFixed(2)}s was required.`), { code: "CORRUPTED_RESULT" });
    }
    return probe;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function assembleMovie(input: {
  clips: Array<{ bytes: Uint8Array; extension?: string; durationSeconds?: number }>;
  resolution: "720p" | "1080p" | "4k";
  outputFormat?: "mp4" | "mov";
}): Promise<{ bytes: Uint8Array; qc: FinalMediaQc }> {
  if (!input.clips.length) throw new Error("Cannot assemble a movie without clips.");
  const tempRoot = path.join(os.tmpdir(), `cineforge-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    const sources: Array<{ filePath: string; durationSeconds?: number }> = [];
    for (let index = 0; index < input.clips.length; index += 1) {
      const source = path.join(tempRoot, `source-${index}.${input.clips[index].extension ?? "mp4"}`);
      await writeFile(source, input.clips[index].bytes);
      sources.push({ filePath: source, durationSeconds: input.clips[index].durationSeconds });
    }
    const output = path.join(tempRoot, `movie.${input.outputFormat ?? "mp4"}`);
    const qc = await assembleMovieFiles({ clips: sources, resolution: input.resolution, outputFormat: input.outputFormat, outputPath: output });
    return { bytes: new Uint8Array(await readFile(output)), qc };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function assembleMovieFiles(input: {
  clips: Array<{ filePath: string; durationSeconds?: number }>;
  resolution: "720p" | "1080p" | "4k";
  outputFormat?: "mp4" | "mov";
  outputPath: string;
  onProgress?: (stage: string, completed: number, total: number) => Promise<void>;
}): Promise<FinalMediaQc> {
  if (!input.clips.length) throw new Error("Cannot assemble a movie without clips.");
  const tempRoot = path.join(path.dirname(input.outputPath), `cineforge-normalized-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    const firstProbe = await probeMedia(input.clips[0].filePath);
    const landscape = input.resolution === "4k" ? [3840, 2160] : input.resolution === "1080p" ? [1920, 1080] : [1280, 720];
    const dimensions = (firstProbe.height > firstProbe.width ? landscape.toReversed() : landscape).join(":");
    const normalized: string[] = [];
    const durations: number[] = [];
    for (let index = 0; index < input.clips.length; index += 1) {
      const source = input.clips[index].filePath;
      const target = path.join(tempRoot, `clip-${index}.mov`);
      const sourceProbe = await probeMedia(source);
      if (!sourceProbe.hasVideo) throw new Error(`Invalid media: source clip ${index + 1} has no video stream.`);
      const clipDuration = input.clips[index].durationSeconds ?? sourceProbe.videoDuration ?? sourceProbe.duration;
      if (!Number.isFinite(clipDuration) || clipDuration <= 0) throw new Error(`Invalid media: clip ${index + 1} has invalid duration.`);
      if ((sourceProbe.videoDuration ?? sourceProbe.duration) + 1 / 24 < clipDuration) throw new Error(`Invalid media: clip ${index + 1} is shorter than its planned duration.`);
      durations.push(clipDuration);
      // Copy only frame-exact sources. -t with stream copy can retain B-frames
      // past the cut; audio padding must not decide the next clip's timestamp.
      const canCopyVideo = `${sourceProbe.width}:${sourceProbe.height}` === dimensions
        && sourceProbe.codec === "h264" && Math.abs(sourceProbe.frameRate - 24) < 0.01
        && Math.abs((sourceProbe.videoDuration ?? sourceProbe.duration) - clipDuration) < 1 / 48
        && Math.abs(sourceProbe.videoStart ?? 0) < 1 / 48;
      const audioBoundaryFilter = clipDuration
        ? `atrim=start=0:end=${clipDuration.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,afade=t=in:st=0:d=0.04,afade=t=out:st=${Math.max(0, clipDuration - 0.06).toFixed(3)}:d=0.06,loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur=${clipDuration.toFixed(3)},atrim=end=${clipDuration.toFixed(3)}`
        : "aresample=48000:async=1:first_pts=0,loudnorm=I=-16:TP=-1.5:LRA=11";
      await execFileAsync(env().FFMPEG_PATH, [
        "-y", "-nostdin", "-threads", "2", "-filter_threads", "2", "-i", source,
        ...(!sourceProbe.hasAudio ? ["-f", "lavfi", "-t", (clipDuration ?? sourceProbe.duration).toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"] : []),
        ...(clipDuration ? ["-t", clipDuration.toFixed(3)] : []),
        "-map", "0:v:0", "-map", sourceProbe.hasAudio ? "0:a:0" : "1:a:0",
        ...(!canCopyVideo ? ["-vf", `trim=duration=${clipDuration},setpts=PTS-STARTPTS,scale=${dimensions}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${dimensions}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p`] : []),
        // Every generated shot is an isolated audio context. Trimming, resetting
        // timestamps and fading the few boundary milliseconds prevents packets,
        // old speech or a finished music cue from leaking into the next shot.
        "-af", audioBoundaryFilter,
        ...(canCopyVideo ? ["-c:v", "copy"] : ["-c:v", "libx264", "-threads:v", "1", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "18", "-x264-params", "ref=1:rc-lookahead=0:sync-lookahead=0"]),
        // PCM intermediates avoid accumulating AAC encoder delay at every cut.
        // Encode AAC once, in the final mux, preserving native Google voices.
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-video_track_timescale", "24000", target,
      ], { maxBuffer: 2 * 1024 * 1024, timeout: 10 * 60_000, windowsHide: true });
      normalized.push(target);
      await input.onProgress?.("normalizing", index + 1, input.clips.length);
    }
    const concatFile = path.join(tempRoot, "concat.txt");
    await writeFile(concatFile, normalized.map((file, index) => `file '${file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'\nduration ${durations[index].toFixed(6)}`).join("\n"));
    const expectedDuration = durations.reduce((sum, duration) => sum + duration, 0);
    await input.onProgress?.("muxing", input.clips.length, input.clips.length);
    await execFileAsync(env().FFMPEG_PATH, [
      "-y", "-nostdin", "-threads", "1", "-f", "concat", "-safe", "0", "-i", concatFile,
      "-t", expectedDuration.toFixed(6), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", input.outputPath,
    ], { maxBuffer: 2 * 1024 * 1024, timeout: 10 * 60_000, windowsHide: true });
    await input.onProgress?.("quality-check", input.clips.length, input.clips.length);
    return await finalMediaQc(input.outputPath, dimensions, expectedDuration);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function finalMediaQc(filePath: string, expectedDimensions: string, expectedDuration?: number): Promise<FinalMediaQc> {
  const probe = await probeMedia(filePath);
  const issues: string[] = [];
  const [expectedWidth, expectedHeight] = expectedDimensions.split(":").map(Number);
  if (!probe.hasVideo) issues.push("Missing video stream");
  if (!probe.hasAudio) issues.push("Missing audio stream");
  if (probe.width !== expectedWidth || probe.height !== expectedHeight) issues.push("Resolution mismatch");
  if (Math.abs(probe.frameRate - 24) > 0.01) issues.push("Frame-rate mismatch");
  if (probe.hasAudio && probe.sampleRate !== 48_000) issues.push("Audio sample-rate mismatch");
  if (expectedDuration !== undefined && Math.abs(probe.duration - expectedDuration) > 0.5) {
    issues.push(`Duration mismatch: expected ${expectedDuration.toFixed(2)}s, received ${probe.duration.toFixed(2)}s`);
  }
  const blackScan = await execFileAsync(env().FFMPEG_PATH, [
    "-hide_banner", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", filePath, "-vf", "blackdetect=d=0.4:pic_th=0.98:pix_th=0.02", "-an", "-f", "null", "-",
  ], { maxBuffer: 2 * 1024 * 1024, timeout: 10 * 60_000, windowsHide: true });
  const blackFrameSegments = (blackScan.stderr.match(/black_start:/g) ?? []).length;
  if (blackFrameSegments) issues.push(`${blackFrameSegments} unexpected black-frame segment(s)`);
  let audioMaxVolumeDb: number | null = null;
  if (probe.hasAudio) {
    const audioScan = await execFileAsync(env().FFMPEG_PATH, [
      "-hide_banner", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", filePath, "-af", "volumedetect", "-vn", "-f", "null", "-",
    ], { maxBuffer: 2 * 1024 * 1024, timeout: 10 * 60_000, windowsHide: true });
    const match = audioScan.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/i);
    audioMaxVolumeDb = match ? Number(match[1]) : null;
    if (audioMaxVolumeDb !== null && audioMaxVolumeDb > -0.1) issues.push("Potential audio clipping");
  }
  return {
    passed: issues.length === 0,
    probe,
    blackFrameSegments,
    audioMaxVolumeDb,
    audioClipping: audioMaxVolumeDb !== null && audioMaxVolumeDb > -0.1,
    expectedResolution: expectedDimensions.replace(":", "×"),
    issues,
  };
}

export async function patchDialogueAudio(input: {
  video: Uint8Array;
  speech: Uint8Array;
  startSeconds: number;
  endSeconds: number;
}): Promise<Uint8Array> {
  const tempRoot = path.join(os.tmpdir(), `cineforge-dialogue-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    const source = path.join(tempRoot, "source.mp4");
    const speech = path.join(tempRoot, "speech.mp3");
    const output = path.join(tempRoot, "patched.mp4");
    await writeFile(source, input.video);
    await writeFile(speech, input.speech);
    const delayMs = Math.max(0, Math.round(input.startSeconds * 1000));
    const targetSpeechDuration = Math.max(0.05, input.endSeconds - input.startSeconds);
    const speechProbe = await probeMedia(speech);
    const tempo = speechProbe.duration > targetSpeechDuration ? Math.min(100, speechProbe.duration / targetSpeechDuration) : 1;
    const speechDuration = targetSpeechDuration.toFixed(3);
    const start = input.startSeconds.toFixed(3);
    const end = input.endSeconds.toFixed(3);
    await execFileAsync(env().FFMPEG_PATH, [
      "-y", "-nostdin", "-threads", "1", "-filter_complex_threads", "1", "-i", source, "-i", speech,
      "-filter_complex",
      `[0:a]volume=enable='between(t,${start},${end})':volume=0[base];[1:a]atempo=${tempo.toFixed(5)},atrim=start=0:duration=${speechDuration},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},volume=1.0[voice];[base][voice]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[mix]`,
      "-map", "0:v:0", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-threads:a", "1", "-b:a", "192k",
      "-ar", "48000", "-movflags", "+faststart", output,
    ], { maxBuffer: 16 * 1024 * 1024 });
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function extractRepresentativeFrame(video: Uint8Array): Promise<Uint8Array> {
  const tempRoot = path.join(os.tmpdir(), `cineforge-frame-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    const source = path.join(tempRoot, "source.mp4");
    const output = path.join(tempRoot, "preview.jpg");
    await writeFile(source, video);
    await execFileAsync(env().FFMPEG_PATH, [
      "-y", "-nostdin", "-threads", "1", "-filter_threads", "1", "-ss", "1", "-i", source, "-frames:v", "1",
      "-vf", "scale=768:-2", "-q:v", "3", output,
    ], { maxBuffer: 8 * 1024 * 1024 });
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export type ShotQcFrame = {
  label: "CURRENT_START" | "CURRENT_MIDDLE" | "CURRENT_END";
  bytes: Uint8Array;
};

/**
 * A single thumbnail cannot reveal a teleport, a disappearing object or a
 * person crossing solid geometry. Extract three ordered observations so the
 * continuity director can judge motion through time, not merely composition.
 */
export async function extractShotQcFrames(video: Uint8Array): Promise<ShotQcFrame[]> {
  const tempRoot = path.join(os.tmpdir(), `cineforge-qc-frames-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    const source = path.join(tempRoot, "source.mp4");
    await writeFile(source, video);
    const probe = await probeMedia(source);
    const end = Math.max(0.02, probe.duration - 0.12);
    const observations = [
      { label: "CURRENT_START" as const, seconds: Math.min(end, 0.08) },
      { label: "CURRENT_MIDDLE" as const, seconds: Math.min(end, Math.max(0.02, probe.duration / 2)) },
      { label: "CURRENT_END" as const, seconds: end },
    ];
    const frames: ShotQcFrame[] = [];
    for (const [index, observation] of observations.entries()) {
      const output = path.join(tempRoot, `frame-${index}.jpg`);
      await execFileAsync(env().FFMPEG_PATH, [
        "-y", "-nostdin", "-threads", "1", "-filter_threads", "1",
        "-ss", observation.seconds.toFixed(3), "-i", source, "-frames:v", "1",
        "-vf", "scale=768:-2", "-q:v", "3", output,
      ], { maxBuffer: 8 * 1024 * 1024 });
      frames.push({ label: observation.label, bytes: new Uint8Array(await readFile(output)) });
    }
    return frames;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function extractFinalFrame(video: Uint8Array): Promise<Uint8Array> {
  const tempRoot = path.join(os.tmpdir(), `cineforge-final-frame-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    const source = path.join(tempRoot, "source.mp4");
    const output = path.join(tempRoot, "final.jpg");
    await writeFile(source, video);
    await execFileAsync(env().FFMPEG_PATH, [
      "-y", "-nostdin", "-threads", "1", "-filter_threads", "1", "-sseof", "-0.12", "-i", source, "-frames:v", "1",
      "-vf", "scale=1024:-2", "-q:v", "2", output,
    ], { maxBuffer: 8 * 1024 * 1024 });
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function parseRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split("/").map(Number);
  return denominator ? numerator / denominator : numerator;
}
