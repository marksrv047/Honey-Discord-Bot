/**
 * Comprehensive Color Resolution and Normalization Utility for Honey Bot.
 */

export const STANDARD_COLORS = {
  'dark red': '#8B0000',
  'darkred': '#8B0000',
  'red': '#FF0000',
  'light red': '#FF7F7F',
  'dark blue': '#00008B',
  'darkblue': '#00008B',
  'blue': '#0000FF',
  'light blue': '#ADD8E6',
  'skyblue': '#87CEEB',
  'sky blue': '#87CEEB',
  'dark green': '#006400',
  'darkgreen': '#006400',
  'green': '#008000',
  'light green': '#90EE90',
  'lime': '#00FF00',
  'yellow': '#FFFF00',
  'purple': '#800080',
  'dark purple': '#4B0082',
  'orange': '#FFA500',
  'dark orange': '#FF8C00',
  'gold': '#FFD700',
  'dark gold': '#B8860B',
  'pink': '#FFC0CB',
  'hot pink': '#FF69B4',
  'cyan': '#00FFFF',
  'teal': '#008080',
  'magenta': '#FF00FF',
  'white': '#FFFFFF',
  'black': '#000001', // Discord treats #000000 as default/transparent, so #000001 provides true dark
  'grey': '#808080',
  'gray': '#808080',
  'dark grey': '#A9A9A9',
  'dark gray': '#A9A9A9',
  'light grey': '#D3D3D3',
  'light gray': '#D3D3D3',
  'blurple': '#5865F2',
  'navy': '#000080',
  'maroon': '#800000',
  'olive': '#808000',
  'coral': '#FF7F50',
  'crimson': '#DC143C'
};

/**
 * Resolves a natural language color name or hex string into a validated 7-character hex string (#RRGGBB).
 * Returns null if the color cannot be resolved.
 */
export function resolveColor(input) {
  if (!input) return null;
  const str = String(input).trim().toLowerCase();

  // 1. Direct standard name lookup
  if (STANDARD_COLORS[str]) {
    return STANDARD_COLORS[str];
  }

  // 2. Stripped prefix lookup (e.g. "color dark red", "color: dark red")
  const cleanName = str.replace(/^color[:\s]+/, '').trim();
  if (STANDARD_COLORS[cleanName]) {
    return STANDARD_COLORS[cleanName];
  }

  // 3. Hex code matching #RGB or #RRGGBB
  const hexMatch = str.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const raw = hexMatch[1];
    if (raw.length === 3) {
      // Expand #RGB to #RRGGBB
      return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toUpperCase();
    }
    return `#${raw.toUpperCase()}`;
  }

  return null;
}

/**
 * Validates whether an input represents a valid hex color code
 */
export function isValidHexColor(str) {
  if (!str) return false;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(str);
}
