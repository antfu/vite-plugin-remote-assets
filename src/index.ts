import { dirname, extname, relative, resolve } from 'path'
import axios from 'axios'
import { createWriteStream, emptyDir, ensureDir, existsSync, unlink } from 'fs-extra'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import _debug from 'debug'
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

const debug = _debug('vite-plugin-remote-assets')

export function VitePluginRemoteAssets(options: RemoteAssetsOptions = {}): Plugin {
  const {
    assetsDir = 'node_modules/.remote-assets',
    rules = DefaultRules,
    resolveMode = 'relative',
    awaitDownload = true,
  } = options

  let dir: string = undefined!
  let config: ResolvedConfig
  let server: ViteDevServer | undefined

  async function downloadTo(url: string, filepath: string): Promise<void> {
    const writer = createWriteStream(filepath)

    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
    })

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

        if (!existsSync(filepath) || tasksMap[filepath]) {
          if (!tasksMap[filepath]) {
            tasksMap[filepath] = (async () => {
              try {
                debug('downloading', url)
                await downloadTo(url, filepath)
                debug('downloaded', url)
              }
              catch (e) {
                if (existsSync(filepath))
                  await unlink(filepath)
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
      if (config.server.force)
        await emptyDir(dir)
      await ensureDir(dir)
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
