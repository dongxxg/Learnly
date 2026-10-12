/**
 * hanzi-writer 2.x 环境声明（2.x 无官方 types）。
 * 仅声明本项目消费的方法面；完整 API 见 https://chanind.github.io/hanzi-writer
 */
declare module 'hanzi-writer' {
  export default class HanziWriter {
    constructor(element: unknown, options?: Record<string, unknown>)
    /** 装载汉字（经 charDataLoader）并渲染初始状态。 */
    setCharacter(char: string): Promise<void>
    animateCharacter(options?: Record<string, unknown>): Promise<void>
    loopCharacterAnimation(options?: Record<string, unknown>): Promise<void>
    quiz(options?: Record<string, unknown>): Promise<void>
    cancelQuiz(): void
    pauseAnimation(): void
    resumeAnimation(): void
    hideCharacter(): void
    showCharacter(): Promise<void>
    /** 渲染目标实例（rendererOverride.createRenderTarget 的返回值）。 */
    target: { trigger(name: string, evt: unknown): void }
  }
}
