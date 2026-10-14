import type { ApiEnvironment } from "./index";

export type LibraryMediaType = "video" | "audio" | "image" | "document";
export type AcceptedLibraryFile = { mediaType: LibraryMediaType; mimeType: string; extension: string; browserPlayable: boolean };

type Definition = { mediaType: LibraryMediaType; extensions: string[]; browserPlayable?: boolean };
const definitions: Record<string, Definition> = {
  "image/jpeg": { mediaType: "image", extensions: ["jpg", "jpeg"], browserPlayable: true },
  "image/png": { mediaType: "image", extensions: ["png"], browserPlayable: true },
  "image/webp": { mediaType: "image", extensions: ["webp"], browserPlayable: true },
  "image/gif": { mediaType: "image", extensions: ["gif"], browserPlayable: true },
  "application/pdf": { mediaType: "document", extensions: ["pdf"], browserPlayable: true },
  "text/plain": { mediaType: "document", extensions: ["txt"] },
  "text/markdown": { mediaType: "document", extensions: ["md", "markdown"] },
  "audio/mpeg": { mediaType: "audio", extensions: ["mp3"], browserPlayable: true },
  "audio/mp4": { mediaType: "audio", extensions: ["m4a", "mp4"], browserPlayable: true },
  "audio/ogg": { mediaType: "audio", extensions: ["ogg", "oga"], browserPlayable: true },
  "audio/wav": { mediaType: "audio", extensions: ["wav"], browserPlayable: true },
  "video/mp4": { mediaType: "video", extensions: ["mp4", "m4v"], browserPlayable: true },
  "video/webm": { mediaType: "video", extensions: ["webm"], browserPlayable: true },
  "video/x-ms-wmv": { mediaType: "video", extensions: ["wmv"] },
  "video/x-ms-asf": { mediaType: "video", extensions: ["wmv"] }
};
const extensionFallbacks: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", wmv: "video/x-ms-wmv"
};

const numberSetting = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};
export const fileExtension = (name: string) => name.toLowerCase().split(".").pop() ?? "";
export function acceptedLibraryFile(filename: string, suppliedMimeType: string): AcceptedLibraryFile | null {
  const extension = fileExtension(filename);
  const supplied = suppliedMimeType.trim().toLowerCase();
  const mimeType = supplied && definitions[supplied]?.extensions.includes(extension) ? supplied : extensionFallbacks[extension];
  const definition = mimeType ? definitions[mimeType] : null;
  if (!definition || !definition.extensions.includes(extension)) return null;
  return { mediaType: definition.mediaType, mimeType, extension, browserPlayable: Boolean(definition.browserPlayable) };
}
export function libraryUploadPolicy(env: ApiEnvironment) {
  const maxBytesByType: Record<LibraryMediaType, number> = {
    image: numberSetting(env.CONTENT_LIBRARY_MAX_IMAGE_BYTES, 250_000_000, 1_000_000, 5_000_000_000),
    document: numberSetting(env.CONTENT_LIBRARY_MAX_DOCUMENT_BYTES, 250_000_000, 1_000_000, 5_000_000_000),
    audio: numberSetting(env.CONTENT_LIBRARY_MAX_AUDIO_BYTES, 1_000_000_000, 5_000_000, 5_000_000_000),
    video: numberSetting(env.CONTENT_LIBRARY_MAX_VIDEO_BYTES, 2_000_000_000, 5_000_000, 5_000_000_000)
  };
  return {
    maxBytesByType,
    directUploadThresholdBytes: numberSetting(env.CONTENT_LIBRARY_DIRECT_UPLOAD_THRESHOLD_BYTES, 50_000_000, 5_000_000, 75_000_000),
    partSizeBytes: numberSetting(env.CONTENT_LIBRARY_MULTIPART_PART_BYTES, 10 * 1024 * 1024, 5 * 1024 * 1024, 75_000_000),
    resumeHours: numberSetting(env.CONTENT_LIBRARY_UPLOAD_RESUME_HOURS, 24, 1, 168),
    acceptedExtensions: Object.keys(extensionFallbacks).map((value) => `.${value}`)
  };
}

const wmvHeader = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
export function validWmvHeader(bytes: Uint8Array): boolean {
  return bytes.length >= wmvHeader.length && wmvHeader.every((value, index) => bytes[index] === value);
}
export function safeLibraryFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-120) || "content";
}
