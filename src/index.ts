import { dirname, extname, relative, resolve } from 'node:path'
import axios from 'axios'
import fs from 'fs-extra'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import Debug from 'debug'
import md5 from 'blueimp-md5'
import MagicString from 'magic-string'
import { slash } from '@antfu/utils'

export interface RemoteAssetsRule {
  /**
   * Regex to match urls, should be http:// or https://
   */
  match: RegExp
  /**
   * Extension for the url, should by leading with `.`
   *
   * When not specified, if will try to infer from the url.
   */
  ext?: string
}

export interface RemoteAssetsOptions {
  /**
   * Directory name to store the assets from remote
   *
   * @default 'node_modules/.remote-assets'
   */
  assetsDir?: string

  /**
   * Rules to match urls to replace
   */
  rules?: RemoteAssetsRule[]

  /**
   * Mode to resolve urls
   *
   * @default relative
   */
  resolveMode?: 'relative' | '@fs' | ((moduleId: string, url: string) => 'relative' | '@fs')

  /**
   * Wait for download before serving the content
   *
   * @default true
   */
  awaitDownload?: boolean

  /**
   * If download returns 429, use the retry-after header to wait and retry
   *
   * @default false
   */
  retryTooManyRequests?: boolean
}

export const DefaultRules: RemoteAssetsRule[] = [
  {
    match: /\b(https?:\/\/[\w_#&?.\/-]*?\.(?:png|jpe?g|svg|ico))(?=[`'")\]])/ig,
  },
]

function isValidHttpUrl(str: string) {
  let url
  try {
    url = new URL(str)
  }
  catch (_) {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

const debug = Debug('vite-plugin-remote-assets')

export function VitePluginRemoteAssets(options: RemoteAssetsOptions = {}): Plugin {
  const {
    assetsDir = 'node_modules/.remote-assets',
    rules = DefaultRules,
    resolveMode = 'relative',
    awaitDownload = true,
    retryTooManyRequests = false,
  } = options

  let dir: string = undefined!
  let config: ResolvedConfig
  let server: ViteDevServer | undefined

  async function downloadTo(url: string, filepath: string, { retryTooManyRequests }: { retryTooManyRequests: boolean }): Promise<void> {
    const writer = fs.createWriteStream(filepath)

    const response = await axios({
      url,
      method: 'GET',
      validateStatus: (status) => {
        if (status >= 200 && status < 300)
          return true
        else if (retryTooManyRequests && status === 429)
          return true
        else
          return false
      },
      responseType: 'stream',
    })

    if (response.status === 429) {
      const retryAfter = response.headers['retry-after']
      if (!retryAfter) {
        throw new Error(`${url}: 429 without retry-after header`)
      }
      else {
        debug(`${url}: 429, retry after ${retryAfter} seconds`)
        await sleep(retryAfter)
        return await downloadTo(url, filepath, { retryTooManyRequests })
      }
    }

    response.data.pipe(writer)

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve)
      writer.on('error', reject)
    })
  }

  const tasksMap: Record<string, Promise<void> | undefined> = {}

  async function transform(code: string, id: string) {
    const tasks: Promise<void>[] = []

    const s = new MagicString(code)

    let hasReplaced = false
    let match

    for (const rule of rules) {
      rule.match.lastIndex = 0
      // eslint-disable-next-line no-cond-assign
      while ((match = rule.match.exec(code))) {
        const start = match.index
        const end = start + match[0].length
        const url = match[0]
        if (!url || !isValidHttpUrl(url))
          continue

        const hash = md5(url) + (rule.ext || extname(url))
        const filepath = slash(resolve(dir, hash))

        debug('detected', url, hash)

        if (!fs.existsSync(filepath) || tasksMap[filepath]) {
          if (!tasksMap[filepath]) {
            tasksMap[filepath] = (async () => {
              try {
                debug('downloading', url)
                await downloadTo(url, filepath, { retryTooManyRequests })
                debug('downloaded', url)
              }
              catch (e) {
                if (fs.existsSync(filepath))
                  await fs.unlink(filepath)
                throw e
              }
              finally {
                delete tasksMap[filepath]
              }
            })()
          }
          tasks.push(tasksMap[filepath]!)

          if (!awaitDownload)
            continue
        }

        hasReplaced = true

        const mode = typeof resolveMode === 'function' ? resolveMode(id, url) : resolveMode

        let newUrl: string

        if (mode === 'relative') {
          newUrl = slash(relative(dirname(id), `${dir}/${hash}`))
          if (newUrl[0] !== '.')
            newUrl = `./${newUrl}`
        }
        else {
          let path = `${dir}/${hash}`
          if (!path.startsWith('/'))
            path = `/${path}`
          newUrl = `/@fs${path}`
        }

        s.overwrite(start, end, newUrl)
      }
    }

    if (tasks.length) {
      if (awaitDownload) {
        await Promise.all(tasks)
      }
      else {
        Promise.all(tasks).then(() => {
          if (server) {
            const module = server.moduleGraph.getModuleById(id)
            if (module)
              server.moduleGraph.invalidateModule(module)
          }
        })
      }
    }

    if (!hasReplaced)
      return null

    return {
      code: s.toString(),
      map: config.build.sourcemap ? s.generateMap({ hires: true }) : null,
    }
  }

  return {
    name: 'vite-plugin-remote-assets',
    enforce: 'pre',
    async configResolved(_config) {
      config = _config
      dir = slash(resolve(config.root, assetsDir))
      if (('force' in config.server && config.server.force) || config.optimizeDeps.force)
        await fs.emptyDir(dir)
      await fs.ensureDir(dir)
    },
    configureServer(_server) {
      server = _server
    },
    async transform(code, id) {
      return await transform(code, id)
    },
    transformIndexHtml: {
      enforce: 'pre',
      async transform(code, ctx) {
        return (await transform(code, ctx.filename))?.code
      },
    },
  } as Plugin
}

export default VitePluginRemoteAssets
