/**
 * 图片处理管线（第六步工具层的图片能力扩展，见 AGENTS.md §1.3 / §7）。
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
