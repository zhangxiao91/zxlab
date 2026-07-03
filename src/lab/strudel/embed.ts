export const STRUDEL_ORIGIN = "https://strudel.cc";
export const STRUDEL_REPL_URL = `${STRUDEL_ORIGIN}/`;

export function encodeStrudelSource(source: string) {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function createStrudelUrl(source: string) {
  return `${STRUDEL_REPL_URL}#${encodeURIComponent(encodeStrudelSource(source))}`;
}
