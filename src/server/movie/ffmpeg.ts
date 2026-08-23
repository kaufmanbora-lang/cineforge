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

export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const { stdout } = await execFileAsync(env().FFPROBE_PATH, [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", filePath,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const payload = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string }>;
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
  };
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
    const dimensions = input.resolution === "4k" ? "3840:2160" : input.resolution === "1080p" ? "1920:1080" : "1280:720";
    const normalized: string[] = [];
    for (let index = 0; index < input.clips.length; index += 1) {
      const source = path.join(tempRoot, `source-${index}.${input.clips[index].extension ?? "mp4"}`);
      const target = path.join(tempRoot, `clip-${index}.mp4`);
      await writeFile(source, input.clips[index].bytes);
      const clipDuration = input.clips[index].durationSeconds;
      const audioBoundaryFilter = clipDuration
        ? `atrim=start=0:end=${clipDuration.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,afade=t=in:st=0:d=0.04,afade=t=out:st=${Math.max(0, clipDuration - 0.06).toFixed(3)}:d=0.06,loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur=${clipDuration.toFixed(3)},atrim=end=${clipDuration.toFixed(3)}`
        : "aresample=48000:async=1:first_pts=0,loudnorm=I=-16:TP=-1.5:LRA=11";
      await execFileAsync(env().FFMPEG_PATH, [
        "-y", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", source,
        ...(input.clips[index].durationSeconds ? ["-t", input.clips[index].durationSeconds!.toFixed(3)] : []),
        "-vf", `scale=${dimensions}:force_original_aspect_ratio=decrease,pad=${dimensions}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p`,
        // Every generated shot is an isolated audio context. Trimming, resetting
        // timestamps and fading the few boundary milliseconds prevents packets,
        // old speech or a finished music cue from leaking into the next shot.
        "-af", audioBoundaryFilter,
        "-c:v", "libx264", "-threads:v", "1", "-preset", "veryfast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", target,
      ], { maxBuffer: 16 * 1024 * 1024 });
      normalized.push(target);
    }
    const concatFile = path.join(tempRoot, "concat.txt");
    await writeFile(concatFile, normalized.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
    const output = path.join(tempRoot, `movie.${input.outputFormat ?? "mp4"}`);
    await execFileAsync(env().FFMPEG_PATH, [
      "-y", "-nostdin", "-threads", "1", "-f", "concat", "-safe", "0", "-i", concatFile,
      "-c", "copy", "-movflags", "+faststart", output,
    ], { maxBuffer: 16 * 1024 * 1024 });
    const qc = await finalMediaQc(output, dimensions);
    return { bytes: new Uint8Array(await readFile(output)), qc };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function finalMediaQc(filePath: string, expectedDimensions: string): Promise<FinalMediaQc> {
  const probe = await probeMedia(filePath);
  const issues: string[] = [];
  const [expectedWidth, expectedHeight] = expectedDimensions.split(":").map(Number);
  if (!probe.hasVideo) issues.push("Missing video stream");
  if (!probe.hasAudio) issues.push("Missing audio stream");
  if (probe.width !== expectedWidth || probe.height !== expectedHeight) issues.push("Resolution mismatch");
  if (Math.abs(probe.frameRate - 24) > 0.01) issues.push("Frame-rate mismatch");
  if (probe.hasAudio && probe.sampleRate !== 48_000) issues.push("Audio sample-rate mismatch");
  const blackScan = await execFileAsync(env().FFMPEG_PATH, [
    "-hide_banner", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", filePath, "-vf", "blackdetect=d=0.4:pic_th=0.98:pix_th=0.02", "-an", "-f", "null", "-",
  ], { maxBuffer: 16 * 1024 * 1024 });
  const blackFrameSegments = (blackScan.stderr.match(/black_start:/g) ?? []).length;
  if (blackFrameSegments) issues.push(`${blackFrameSegments} unexpected black-frame segment(s)`);
  let audioMaxVolumeDb: number | null = null;
  if (probe.hasAudio) {
    const audioScan = await execFileAsync(env().FFMPEG_PATH, [
      "-hide_banner", "-nostdin", "-threads", "1", "-filter_threads", "1", "-i", filePath, "-af", "volumedetect", "-vn", "-f", "null", "-",
    ], { maxBuffer: 16 * 1024 * 1024 });
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
    const start = input.startSeconds.toFixed(3);
    const end = input.endSeconds.toFixed(3);
    await execFileAsync(env().FFMPEG_PATH, [
      "-y", "-nostdin", "-threads", "1", "-filter_complex_threads", "1", "-i", source, "-i", speech,
      "-filter_complex",
      `[0:a]volume=enable='between(t,${start},${end})':volume=0[base];[1:a]adelay=${delayMs}|${delayMs},volume=1.0[voice];[base][voice]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[mix]`,
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
