interface KeyLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
}

export function isSlashKey(key: KeyLike): boolean {
  if (key.ctrl || key.meta || key.option) return false;
  return key.sequence === "/" || key.name === "/";
}

export function isTabKey(key: KeyLike): boolean {
  return key.name === "tab";
}
