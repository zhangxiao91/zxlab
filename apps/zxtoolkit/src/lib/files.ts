export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_TOTAL_SIZE = 50 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function validateFiles(files: File[]): string | null {
  if (!files.length) return "没有找到可发送的文件";
  if (files.length > MAX_FILES) return `一次最多发送 ${MAX_FILES} 个文件`;
  if (!ALLOWED_IMAGE_TYPES.has(files[0]?.type.toLowerCase())) return "当前版本仅支持 PNG、JPEG、WebP 和 GIF 图片";
  if (files.some((file) => file.size > MAX_FILE_SIZE)) return "单个文件不能超过 20 MB";
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_SIZE) return "单次文件总大小不能超过 50 MB";
  return null;
}

export async function shareFile(blob: Blob, fileName: string): Promise<"shared" | "downloaded"> {
  const file = new File([blob], fileName, { type: blob.type || "application/octet-stream" });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: fileName });
    return "shared";
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}

export function downloadFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
