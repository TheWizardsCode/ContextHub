import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { _testOnly_getRemoteTrackingRef, getRemoteDataFileContent } from '../../src/sync.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const mockBinDir = path.join(__dirname, 'mock-bin')

describe('git mock fetch/show roundtrip', () => {
  it('getRemoteTrackingRef matches expectations', () => {
    expect(_testOnly_getRemoteTrackingRef('origin', 'refs/worklog/data')).toBe(
      'refs/worklog/remotes/origin/worklog/data'
    )
    expect(_testOnly_getRemoteTrackingRef('origin', 'main')).toBe('refs/remotes/origin/main')
  })

  it('fetch + show returns remote .worklog/worklog-data.jsonl content', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-git-mock-'))
    const remoteRepo = path.join(tmp, 'remote-repo')
    fs.mkdirSync(remoteRepo, { recursive: true })
    // create remote .worklog with sample content
    const worklogDir = path.join(remoteRepo, '.worklog')
    fs.mkdirSync(worklogDir, { recursive: true })
    const jsonl = path.join(worklogDir, 'worklog-data.jsonl')
    const sample = '{"id":"WI-RT-1","title":"remote"}\n'
    fs.writeFileSync(jsonl, sample, 'utf8')

    // create a local repo that records remote_origin
    const localRepo = path.join(tmp, 'local-repo')
    fs.mkdirSync(localRepo, { recursive: true })
    // create .git and set remote_origin to point to remoteRepo
    fs.mkdirSync(path.join(localRepo, '.git'))
    fs.writeFileSync(path.join(localRepo, '.git', 'remote_origin'), remoteRepo, 'utf8')

    // run fetch via the sync.fetchTargetRef path by invoking getRemoteDataFileContent
    const dataFilePath = path.join(localRepo, '.worklog', 'worklog-data.jsonl')
    // ensure local worklog exists so repo root resolution works
    fs.mkdirSync(path.join(localRepo, '.worklog'), { recursive: true })

    // Replace process cwd for the call to be inside localRepo and inject
    // mock git into PATH so sync module finds our mock instead of real git.
    const oldCwd = process.cwd()
    const oldPath = process.env.PATH
    try {
      process.chdir(localRepo)
      process.env.PATH = `${mockBinDir}${path.delimiter}${oldPath || ''}`
      const content = await getRemoteDataFileContent(dataFilePath, { remote: 'origin', branch: 'refs/worklog/data' })
      expect(content).toContain('"id":"WI-RT-1"')
    } finally {
      process.chdir(oldCwd)
      process.env.PATH = oldPath
    }
  })
})
