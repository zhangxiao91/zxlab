const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeXml(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

export function xmlBlocks(xml: string, localName: string): string[] {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<(?:[\\w-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${escaped}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
}

export function xmlText(block: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = xmlBlocks(block, name)[0];
    if (value !== undefined) return decodeXml(value).trim();
  }
  return undefined;
}

export function xmlAttr(block: string, localName: string, attribute: string, rel?: string): string | undefined {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${localName}\\b([^>]*)\\/?\\s*>`, "gi");
  for (const match of block.matchAll(pattern)) {
    const attrs = match[1] ?? "";
    if (rel) {
      const relValue = attrs.match(/\brel=["']([^"']+)["']/i)?.[1];
      if (relValue !== rel) continue;
    }
    const value = attrs.match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"))?.[1];
    if (value) return decodeXml(value);
  }
  return undefined;
}
