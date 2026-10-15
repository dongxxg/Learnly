/** 古诗模块类型定义（数据文件与工具层共用，避免循环依赖）。 */

/** 一首古诗的文本数据（数据文件维护的形态，拼音由构建期生成后合并）。 */
export interface RawPoem {
  /** 唯一标识（拼音串），列表→详情寻址用 */
  id: string
  /** 诗题（组诗带首句副题，如"悯农（锄禾日当午）"） */
  title: string
  /** 朝代（汉/唐/宋/清…） */
  dynasty: string
  /** 作者（乐府/无名氏等按通行署名） */
  author: string
  /** 诗行（含标点，词按句读分行） */
  lines: readonly string[]
  /** 白话译文（详情页展示） */
  translation: string
}

/** 详情页消费的完整古诗：文本 + 每行拼音（音节以空格分隔，标点不占音节）。 */
export interface Poem extends RawPoem {
  /** 与 lines 平行的拼音行（poems-pinyin-data.ts 构建期生成） */
  linesPinyin: readonly string[]
}

/** 学段：低段=1-2年级，中段=3-4年级，高段=5-6年级。 */
export type PoemStage = 'lower' | 'middle' | 'upper'
