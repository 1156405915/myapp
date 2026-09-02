import { nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import type { AttachmentKind, MessageAttachment } from '../../shared/protocol'
import { validateWorkspacePath } from '../security/workspace-guard'
import { AppStore } from '../store/app-store'

const MAX_ATTACHMENTS = 10
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40_000_000
const MAX_IMAGE_EDGE = 16_384
const TARGET_IMAGE_EDGE = 4_096

interface DetectedFile {
  kind: AttachmentKind
  mimeType: string
  extension: string
  bytes: Buffer
  width?: number
  height?: number
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.toml', '.sql',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp',
  '.cs', '.html', '.css', '.vue', '.svelte', '.sh'
])

/** 安全导入附件，只把经过验证的副本放入固定会话工作区。 */
export class AttachmentManager {
  constructor(private readonly store: AppStore) {}

  /** 导入原生选择器或拖拽得到的本地文件路径。 */
  importPaths(sessionId: string, sourcePaths: string[]): MessageAttachment[] {
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) return []
    if (sourcePaths.length > MAX_ATTACHMENTS) throw new Error(`每次最多添加 ${MAX_ATTACHMENTS} 个附件`)

    const sources = sourcePaths.map((sourcePath) => {
      if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0')) {
        throw new Error('附件路径无效')
      }
      const absolutePath = resolve(sourcePath)
      const sourceStat = lstatSync(absolutePath)
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error('附件必须是普通文件')
      const maxBytes = this.isImageExtension(absolutePath) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
      if (sourceStat.size <= 0 || sourceStat.size > maxBytes) throw new Error(`附件大小无效：${basename(absolutePath)}`)
      return { absolutePath, size: sourceStat.size }
    })
    if (sources.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL_BYTES) {
      throw new Error('单次附件总大小不能超过 100 MB')
    }

    const imported: MessageAttachment[] = []
    try {
      for (const source of sources) {
        const before = statSync(source.absolutePath)
        const bytes = readFileSync(source.absolutePath)
        const after = statSync(source.absolutePath)
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
          throw new Error(`附件读取期间发生变化：${basename(source.absolutePath)}`)
        }
        imported.push(this.persist(sessionId, basename(source.absolutePath), bytes))
      }
      return imported
    } catch (error) {
      for (const attachment of imported) this.discard(attachment.id)
      throw error
    }
  }

  /** 导入剪贴板图片字节；声明的 MIME 只用于早期拒绝，最终类型由文件头决定。 */
  importBytes(sessionId: string, name: string, declaredMimeType: string, bytes: Uint8Array): MessageAttachment {
    if (!declaredMimeType.startsWith('image/')) throw new Error('剪贴板附件必须是图片')
    if (!(bytes instanceof Uint8Array) || bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('剪贴板图片大小无效')
    }
    return this.persist(sessionId, this.sanitizeName(name || 'clipboard-image.png'), Buffer.from(bytes))
  }

  /** 删除尚未发送的附件副本和数据库记录。 */
  discard(attachmentId: string): void {
    const attachment = this.store.getAttachment(attachmentId)
    if (!attachment || !attachment.pending) throw new Error('待发送附件不存在')
    const fullPath = this.resolveAttachmentPath(attachment.sessionId, attachment.relativePath)
    if (existsSync(fullPath)) unlinkSync(fullPath)
    if (!this.store.deletePendingAttachment(attachmentId)) throw new Error('待发送附件删除失败')
  }

  /** 返回已验证的附件绝对路径，仅供主进程定位文件。 */
  getRevealPath(attachmentId: string): string {
    const attachment = this.store.getAttachment(attachmentId)
    if (!attachment) throw new Error('附件不存在')
    return this.resolveAttachmentPath(attachment.sessionId, attachment.relativePath)
  }

  /** 会话删除后清理应用控制的附件目录。 */
  deleteSessionFiles(sessionId: string, workspace: string): void {
    const directory = join(workspace, '.mayi', 'attachments', sessionId)
    const validation = validateWorkspacePath(workspace, directory, true)
    if (!validation.allowed) throw new Error(validation.reason || '附件目录无效')
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  }

  private persist(sessionId: string, originalName: string, inputBytes: Buffer): MessageAttachment {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('附件所属会话不存在')
    const detected = this.detectAndNormalize(originalName, inputBytes)
    const id = randomUUID()
    const directory = join(session.cwd, '.mayi', 'attachments', session.id)
    const preValidation = validateWorkspacePath(session.cwd, directory, true)
    if (!preValidation.allowed) throw new Error(preValidation.reason || '附件目录无效')
    mkdirSync(directory, { recursive: true })
    const directoryValidation = validateWorkspacePath(session.cwd, directory)
    if (!directoryValidation.allowed || lstatSync(directory).isSymbolicLink()) {
      throw new Error(directoryValidation.reason || '附件目录不安全')
    }

    const storedName = `${id}${detected.extension}`
    const fullPath = join(directory, storedName)
    const targetValidation = validateWorkspacePath(session.cwd, fullPath, true)
    if (!targetValidation.allowed) throw new Error(targetValidation.reason || '附件路径无效')
    writeFileSync(fullPath, detected.bytes, { flag: 'wx' })

    const attachment: MessageAttachment = {
      id,
      name: this.sanitizeName(originalName),
      kind: detected.kind,
      mimeType: detected.mimeType,
      size: detected.bytes.length,
      relativePath: relative(session.cwd, fullPath).replaceAll('\\', '/'),
      width: detected.width,
      height: detected.height
    }
    try {
      this.store.saveAttachment(sessionId, attachment)
      return attachment
    } catch (error) {
      unlinkSync(fullPath)
      throw error
    }
  }

  private detectAndNormalize(name: string, bytes: Buffer): DetectedFile {
    const extension = extname(name).toLowerCase()
    if (this.matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      if (extension !== '.png') throw new Error('图片扩展名与文件内容不一致')
      return this.normalizeImage(bytes, 'image/png', '.png')
    }
    if (this.matches(bytes, [0xff, 0xd8, 0xff])) {
      if (!['.jpg', '.jpeg'].includes(extension)) throw new Error('图片扩展名与文件内容不一致')
      return this.normalizeImage(bytes, 'image/jpeg', '.jpg')
    }
    if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') {
      if (extension !== '.gif') throw new Error('图片扩展名与文件内容不一致')
      return this.normalizeImage(bytes, 'image/gif', '.gif')
    }
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
      if (extension !== '.webp') throw new Error('图片扩展名与文件内容不一致')
      return this.normalizeImage(bytes, 'image/webp', '.webp')
    }
    if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
      if (extension !== '.pdf') throw new Error('PDF 扩展名与文件内容不一致')
      return { kind: 'document', mimeType: 'application/pdf', extension: '.pdf', bytes }
    }

    if (this.matches(bytes, [0x50, 0x4b, 0x03, 0x04])) {
      const archiveText = bytes.toString('latin1')
      const officeType = extension === '.docx' && archiveText.includes('word/')
        ? { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx' }
        : extension === '.pptx' && archiveText.includes('ppt/')
          ? { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx' }
          : extension === '.xlsx' && archiveText.includes('xl/')
            ? { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' }
            : undefined
      if (!officeType) throw new Error('Office 文件扩展名与内部格式不一致')
      return { kind: 'document', ...officeType, bytes }
    }

    if (!TEXT_EXTENSIONS.has(extension) || bytes.includes(0)) throw new Error(`不支持的附件格式：${name}`)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text && bytes.length > 0) throw new Error(`文本附件编码无效：${name}`)
    const mimeType = extension === '.csv'
      ? 'text/csv'
      : extension === '.tsv'
        ? 'text/tab-separated-values'
        : extension === '.json'
          ? 'application/json'
          : 'text/plain'
    return { kind: 'text', mimeType, extension, bytes }
  }

  private normalizeImage(bytes: Buffer, mimeType: string, extension: string): DetectedFile {
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) throw new Error('图片无法解码或文件头无效')
    const size = image.getSize()
    if (
      size.width <= 0 || size.height <= 0 || size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE ||
      size.width * size.height > MAX_IMAGE_PIXELS
    ) {
      throw new Error('图片尺寸过大')
    }

    const scale = Math.min(1, TARGET_IMAGE_EDGE / Math.max(size.width, size.height))
    const normalized = scale < 1
      ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), quality: 'best' })
      : image
    const normalizedSize = normalized.getSize()
    let output = mimeType === 'image/jpeg' ? normalized.toJPEG(88) : normalized.toPNG()
    let outputMime = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    let outputExtension = mimeType === 'image/jpeg' ? '.jpg' : '.png'
    if (output.length > 10 * 1024 * 1024) {
      output = normalized.toJPEG(82)
      outputMime = 'image/jpeg'
      outputExtension = '.jpg'
    }
    if (output.length > MAX_IMAGE_BYTES) throw new Error('图片处理后仍然过大')
    return {
      kind: 'image',
      mimeType: outputMime,
      extension: outputExtension,
      bytes: output,
      width: normalizedSize.width,
      height: normalizedSize.height
    }
  }

  private resolveAttachmentPath(sessionId: string, relativePath: string): string {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('附件所属会话不存在')
    const expectedPrefix = `.mayi/attachments/${sessionId}/`
    if (!relativePath.replaceAll('\\', '/').startsWith(expectedPrefix)) throw new Error('附件路径无效')
    const fullPath = resolve(session.cwd, relativePath)
    const validation = validateWorkspacePath(session.cwd, fullPath)
    if (!validation.allowed) throw new Error(validation.reason || '附件路径无效')
    return fullPath
  }

  private sanitizeName(value: string): string {
    const cleaned = basename(value).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim()
    return cleaned.slice(0, 180) || 'attachment'
  }

  private matches(bytes: Buffer, signature: number[]): boolean {
    return signature.every((value, index) => bytes[index] === value)
  }

  private isImageExtension(value: string): boolean {
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(value).toLowerCase())
  }
}
