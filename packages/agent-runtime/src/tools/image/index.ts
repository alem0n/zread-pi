/**
 * 图片处理管线：模型支持图片时归一化 / 缩放 / 转 PNG，失败降级为文本说明（要点见 AGENTS.md §3 工具层）。
 *
 * 对外只暴露 `processImage` 与相关类型；`Read` 工具是唯一消费者。
 * 实现移植自 pi/packages/coding-agent/src/utils/image-*.ts，见各文件头部说明。
 */

export { processImage } from './image-process.js'
export type { ProcessImageOptions, ProcessImageResult } from './image-process.js'
export { resizeImage, formatDimensionNote } from './image-resize.js'
export type { ImageResizeOptions, ResizedImage } from './image-resize.js'
export { convertImageBytesToPng, convertToPng } from './image-convert.js'
export { loadPhoton } from './photon.js'
