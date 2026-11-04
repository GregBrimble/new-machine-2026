declare module "ini-api" {
  export class IniLine {
    key: string | undefined
    value: string | number | boolean | null | undefined
    text: string
    comment: string
  }
  export class IniSection {
    constructor(text?: string)
    name: string | undefined
    lines: IniLine[]
    setValue(key: string, value: string): IniLine
    addLine(text: string): IniLine
  }
  export class Ini {
    constructor(text?: string)
    sections: IniSection[]
    addSection(name: string): IniSection
    stringify(): string
  }
}
