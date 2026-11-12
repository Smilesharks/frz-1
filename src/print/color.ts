// Color helpers for print mode: hex conversion and the CIEDE2000 color difference
// used to warn about near-identical colors.

/** Colors closer than this CIEDE2000 difference are reported as near-identical. */
export const NEAR_IDENTICAL_DELTA_E = 5

export interface Lab {
  l: number
  a: number
  b: number
}

/** Uppercase `#RRGGBB` from a Figma color with 0..1 channels. */
export function toHex(color: RGB): string {
  const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase()
}

/** A Figma color with 0..1 channels from `#RRGGBB`. */
export function fromHex(hex: string): RGB {
  const value = parseInt(hex.slice(1), 16)
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 }
}

/** CIEDE2000 difference between two `#RRGGBB` colors. */
export function deltaE2000(hexA: string, hexB: string): number {
  return ciede2000(toLab(fromHex(hexA)), toLab(fromHex(hexB)))
}

/** sRGB to CIELAB with the D65 white point. */
export function toLab(color: RGB): Lab {
  const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4))
  const r = linear(color.r)
  const g = linear(color.g)
  const b = linear(color.b)
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  return { l: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) }
}

/** CIEDE2000 color difference, following Sharma, Wu and Dalal (2005). */
export function ciede2000(first: Lab, second: Lab): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const degrees = (angle: number) => {
    const value = (angle * 180) / Math.PI
    return value < 0 ? value + 360 : value
  }

  const meanChroma = (Math.hypot(first.a, first.b) + Math.hypot(second.a, second.b)) / 2
  const g = 0.5 * (1 - Math.sqrt(Math.pow(meanChroma, 7) / (Math.pow(meanChroma, 7) + Math.pow(25, 7))))
  const a1 = (1 + g) * first.a
  const a2 = (1 + g) * second.a
  const c1 = Math.hypot(a1, first.b)
  const c2 = Math.hypot(a2, second.b)
  const h1 = c1 === 0 ? 0 : degrees(Math.atan2(first.b, a1))
  const h2 = c2 === 0 ? 0 : degrees(Math.atan2(second.b, a2))

  const deltaL = second.l - first.l
  const deltaC = c2 - c1
  let deltaH = 0
  if (c1 * c2 !== 0) {
    deltaH = h2 - h1
    if (deltaH > 180) deltaH -= 360
    else if (deltaH < -180) deltaH += 360
  }
  const deltaBigH = 2 * Math.sqrt(c1 * c2) * Math.sin(radians(deltaH / 2))

  const meanL = (first.l + second.l) / 2
  const meanC = (c1 + c2) / 2
  let meanH = h1 + h2
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) <= 180) meanH = (h1 + h2) / 2
    else meanH = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2
  }

  const t =
    1 -
    0.17 * Math.cos(radians(meanH - 30)) +
    0.24 * Math.cos(radians(2 * meanH)) +
    0.32 * Math.cos(radians(3 * meanH + 6)) -
    0.2 * Math.cos(radians(4 * meanH - 63))
  const deltaTheta = 30 * Math.exp(-Math.pow((meanH - 275) / 25, 2))
  const rotationC = 2 * Math.sqrt(Math.pow(meanC, 7) / (Math.pow(meanC, 7) + Math.pow(25, 7)))
  const scaleL = 1 + (0.015 * Math.pow(meanL - 50, 2)) / Math.sqrt(20 + Math.pow(meanL - 50, 2))
  const scaleC = 1 + 0.045 * meanC
  const scaleH = 1 + 0.015 * meanC * t
  const rotation = -Math.sin(radians(2 * deltaTheta)) * rotationC

  return Math.sqrt(
    Math.pow(deltaL / scaleL, 2) +
      Math.pow(deltaC / scaleC, 2) +
      Math.pow(deltaBigH / scaleH, 2) +
      rotation * (deltaC / scaleC) * (deltaBigH / scaleH),
  )
}
