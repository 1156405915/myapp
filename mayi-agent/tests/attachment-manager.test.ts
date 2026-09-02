import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '../src/shared/protocol'

const { createFromBufferMock } = vi.hoisted(() => ({ createFromBufferMock: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  },
  nativeImage: {
    createFromBuffer: createFromBufferMock
  }
}))

vi.mock('../src/main/logging/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}))

import { AttachmentManager } from '../src/main/attachments/attachment-manager'
import { AppStore } from '../src/main/store/app-store'

const temporaryDirectories: string[] = []

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  createFromBufferMock.mockReset()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AttachmentManager 安全导入', () => {
  it('把外部文本文件复制为工作区内的 UUID 副本且同名不覆盖', () => {
    const dataDirectory = createTemporaryDirectory('mayi-attachment-db-')
    const workspace = createTemporaryDirectory('mayi-attachment-workspace-')
    const sourceDirectory = createTemporaryDirectory('mayi-attachment-source-')
    const firstSource = join(sourceDirectory, '报告.txt')
    writeFileSync(firstSource, '第一份', 'utf8')

    const store = new AppStore(dataDirectory)
    const session: ChatSession = {
      id: 'attachment-session',
      title: '附件',
      status: 'idle',
      cwd: workspace,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.saveSession(session)
    const manager = new AttachmentManager(store)

    const first = manager.importPaths(session.id, [firstSource])[0]
    writeFileSync(firstSource, '第二份', 'utf8')
    const second = manager.importPaths(session.id, [firstSource])[0]

    expect(first.name).toBe('报告.txt')
    expect(first.relativePath).not.toContain(sourceDirectory)
    expect(first.relativePath).not.toBe(second.relativePath)
    expect(readFileSync(join(workspace, first.relativePath), 'utf8')).toBe('第一份')
    expect(readFileSync(join(workspace, second.relativePath), 'utf8')).toBe('第二份')
    store.close()
  })

  it('拒绝扩展名与文件头不一致的伪装二进制文件', () => {
    const dataDirectory = createTemporaryDirectory('mayi-attachment-db-')
    const workspace = createTemporaryDirectory('mayi-attachment-workspace-')
    const sourceDirectory = createTemporaryDirectory('mayi-attachment-source-')
    const disguised = join(sourceDirectory, '伪装.png')
    writeFileSync(disguised, '%PDF-1.7\nbody', 'utf8')

    const store = new AppStore(dataDirectory)
    store.saveSession({
      id: 'attachment-session',
      title: '附件',
      status: 'idle',
      cwd: workspace,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    const manager = new AttachmentManager(store)

    expect(() => manager.importPaths('attachment-session', [disguised])).toThrow('扩展名与文件内容不一致')
    store.close()
  })

  it('只允许删除未发送附件', () => {
    const dataDirectory = createTemporaryDirectory('mayi-attachment-db-')
    const workspace = createTemporaryDirectory('mayi-attachment-workspace-')
    const sourceDirectory = createTemporaryDirectory('mayi-attachment-source-')
    const source = join(sourceDirectory, 'notes.md')
    writeFileSync(source, '# notes', 'utf8')

    const store = new AppStore(dataDirectory)
    store.saveSession({
      id: 'attachment-session',
      title: '附件',
      status: 'idle',
      cwd: workspace,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    const manager = new AttachmentManager(store)
    const attachment = manager.importPaths('attachment-session', [source])[0]
    manager.discard(attachment.id)

    expect(store.getAttachment(attachment.id)).toBeUndefined()
    expect(() => manager.discard(attachment.id)).toThrow('待发送附件不存在')
    store.close()
  })

  it('规范化图片并记录处理后的尺寸和 MIME', () => {
    const dataDirectory = createTemporaryDirectory('mayi-attachment-db-')
    const workspace = createTemporaryDirectory('mayi-attachment-workspace-')
    const sourceDirectory = createTemporaryDirectory('mayi-attachment-source-')
    const source = join(sourceDirectory, 'large.png')
    writeFileSync(source, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('image-body')
    ]))
    const resized = {
      getSize: () => ({ width: 4096, height: 2048 }),
      toPNG: () => Buffer.from('normalized-png'),
      toJPEG: () => Buffer.from('normalized-jpeg')
    }
    createFromBufferMock.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 8000, height: 4000 }),
      resize: () => resized,
      toPNG: () => Buffer.from('original-png'),
      toJPEG: () => Buffer.from('original-jpeg')
    })

    const store = new AppStore(dataDirectory)
    store.saveSession({
      id: 'attachment-session', title: '附件', status: 'idle', cwd: workspace,
      createdAt: Date.now(), updatedAt: Date.now()
    })
    const attachment = new AttachmentManager(store).importPaths('attachment-session', [source])[0]

    expect(attachment).toMatchObject({
      kind: 'image', mimeType: 'image/png', width: 4096, height: 2048,
      size: Buffer.byteLength('normalized-png')
    })
    expect(readFileSync(join(workspace, attachment.relativePath), 'utf8')).toBe('normalized-png')
    store.close()
  })

  it('识别合法 Office 容器并限制单次附件数量', () => {
    const dataDirectory = createTemporaryDirectory('mayi-attachment-db-')
    const workspace = createTemporaryDirectory('mayi-attachment-workspace-')
    const sourceDirectory = createTemporaryDirectory('mayi-attachment-source-')
    const docx = join(sourceDirectory, 'report.docx')
    writeFileSync(docx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]))

    const store = new AppStore(dataDirectory)
    store.saveSession({
      id: 'attachment-session', title: '附件', status: 'idle', cwd: workspace,
      createdAt: Date.now(), updatedAt: Date.now()
    })
    const manager = new AttachmentManager(store)
    expect(manager.importPaths('attachment-session', [docx])[0]).toMatchObject({
      kind: 'document',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })
    expect(() => manager.importPaths('attachment-session', Array(11).fill(docx))).toThrow('最多添加 10 个附件')
    store.close()
  })
})
