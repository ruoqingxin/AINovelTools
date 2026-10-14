const palette = {
  surface: "#222326", subtle: "#1b1c1f", raised: "#2c2e33",
  text: "#eceef2", muted: "#b5bdc8", faint: "#9fa8b5",
  line: "#41464e", "line-strong": "#59616b", "on-accent": "#ffffff", shadow: "#000000",
  "blue-text": "#9fc3ff", "blue-fill": "#3269c8", "blue-tint": "#24364e",
  "green-text": "#83dbb3", "green-fill": "#17695e", "green-tint": "#233c32",
  "amber-text": "#ffd08a", "amber-fill": "#895512", "amber-tint": "#3c3020",
  "red-text": "#ffb1b6", "red-fill": "#ad3948", "red-tint": "#41252b",
  "violet-text": "#cbb3ff", "violet-fill": "#7354b1", "violet-tint": "#342d45",
} as const;
type Role = keyof typeof palette;
type Declaration = { prop: string; value: string };
type Root = { append: (rule: { selector: string; nodes: { prop: string; value: string }[] }) => unknown };

function parseColor(value: string) {
  if (value.startsWith("rgb")) {
    const channels = value.slice(value.indexOf("(") + 1, -1).trim().split(/[\s,/]+/);
    if (channels.length < 3 || channels.length > 4 || channels.some((channel) => !/^(?:\d*\.?\d+)%?$/.test(channel))) return null;
    const rgb = channels.slice(0, 3).map((channel) => Math.min(1, Number.parseFloat(channel) / (channel.endsWith("%") ? 100 : 255)));
    const opacity = channels[3];
    const alpha = opacity === undefined ? "" : Math.round(Math.min(1, Number.parseFloat(opacity) / (opacity.endsWith("%") ? 100 : 1)) * 255)
      .toString(16).padStart(2, "0");
    return { rgb, alpha };
  }
  const hex = value === "white" ? "ffffff" : value === "black" ? "000000" : value.slice(1);
  const expanded = hex.length <= 4 ? [...hex].map((character) => character.repeat(2)).join("") : hex;
  if (expanded.length !== 6 && expanded.length !== 8) return null;
  return { rgb: [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16) / 255),
    alpha: expanded.slice(6) };
}
function roleFor(prop: string, rgb: number[], alpha: string): Role {
  const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const background = /background|fill|--surface/.test(prop);
  const border = /border|outline|--line/.test(prop);
  if (/shadow/.test(prop) || background && alpha && lightness < 0.3) return "shadow";
  if (delta < 0.055 || saturation < 0.16 || !background && !border && delta < 0.3 && saturation < 0.55) {
    if (border) return prop.includes("strong") ? "line-strong" : "line";
    if (background) return prop.includes("subtle") ? "subtle"
      : lightness > 0.96 ? "surface" : lightness > 0.9 ? "subtle" : "raised";
    if (lightness > 0.98) return "on-accent";
    return lightness < 0.35 ? "text" : lightness < 0.62 ? "muted" : "faint";
  }
  let hue = max === rgb[0] ? ((rgb[1]! - rgb[2]!) / delta) % 6
    : max === rgb[1] ? (rgb[2]! - rgb[0]!) / delta + 2 : (rgb[0]! - rgb[1]!) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  const family = hue < 15 || hue >= 310 ? "red" : hue < 60 ? "amber"
    : hue < 190 ? "green" : hue < 255 ? "blue" : "violet";
  if (border && lightness > 0.65) return "line";
  return `${family}-${background ? lightness > 0.7 ? "tint" : "fill" : "text"}` as Role;
}

function themeVisitors() {
  const tokens = new Map<string, string>();
  return {
    Declaration(declaration: Declaration) {
      const { prop } = declaration;
      if (prop.startsWith("--theme-") || declaration.value.includes("var(--theme-")
        || !/color|background|border|outline|shadow|^fill$|^stroke$|^--/.test(prop)) return;
      // Preserve URLs and quoted strings; only color tokens in parsed declarations are changed.
      declaration.value = declaration.value.replace(
        /url\([^)]*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\brgba?\([^)]*\)|#[\da-f]{3,8}\b|\b(?:white|black)\b/gi,
        (value) => {
          const literal = value.toLowerCase();
          if (!value.startsWith("#") && !literal.startsWith("rgb(") && !literal.startsWith("rgba(")
            && literal !== "white" && literal !== "black") return value;
          const color = parseColor(literal);
          if (!color) return value;
          const role = roleFor(prop, color.rgb, color.alpha);
          const name = `--theme-${role}${color.alpha ? `-${color.alpha}` : ""}`;
          tokens.set(name, `${palette[role]}${color.alpha}`);
          return `var(${name}, ${value})`;
        },
      );
      if (/background/.test(prop)) declaration.value = declaration.value.replace(
        /url\([^)]*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|var\(--((?:[\w]+-)?accent)(-strong)?\)/g,
        (value, accent, strong) => {
          if (!accent) return value;
          const name = strong ? "--theme-action-hover" : "--theme-action";
          tokens.set(name, strong ? "#2457a8" : "#3269c8");
          return `var(${name}, var(--${accent}${strong ?? ""}))`;
        },
      );
    },
    OnceExit(root: Root) {
      if (tokens.size) root.append({ selector: ':root[data-theme="dark"]',
        nodes: [...tokens].map(([prop, value]) => ({ prop, value })) });
    },
  };
}

export function workspaceThemePlugin() {
  return { postcssPlugin: "workspace-theme-tokens", prepare: themeVisitors };
}
