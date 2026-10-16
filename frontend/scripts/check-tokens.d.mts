export interface TokenViolation {
  line: number
  rule: 'hardcoded-hex' | 'hardcoded-rgba' | 'off-scale-font' | 'literal-shadow'
  snippet: string
}

export interface FileScanReport {
  file: string
  isWhitelisted: boolean
  ignoredLines: number
  violations: TokenViolation[]
}

export declare const FONT_SCALE: number[]
export declare function scanStyleContent(
  content: string,
  opts?: { isWhitelisted?: boolean },
): TokenViolation[]
export declare function scanTemplateAttrs(templateHtml: string): TokenViolation[]
export declare function scanSrc(srcDir?: string): FileScanReport[]
