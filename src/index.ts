import { extname, posix, dirname } from 'path'
import { http, https } from 'follow-redirects'
import { existsSync, createWriteStream, ensureDir, emptyDir } from 'fs-extra'
import type { Plugin, ResolvedConfig } from 'vite'
import _debug from 'debug'
import md5 from 'blueimp-md5'
import MagicString from 'magic-string'

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
  } = options

  let dir: string = undefined!
  let config: ResolvedConfig

  async function downloadTo(url: string, filepath: string): Promise<void> {
    const file = createWriteStream(filepath)
    const client = url.startsWith('https') ? https : http
    const request = client.request(url, res => res.pipe(file))

    return new Promise((resolve, reject) => {
      request.on('finish', resolve)
      request.on('error', (e) => {
        file.destroy()
        reject(e)
      })
    })
  }

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

        hasReplaced = true
        const hash = md5(url) + (rule.ext || extname(url))
        const filepath = posix.join(dir, hash)

        debug('detected', url, hash)

        if (!existsSync(filepath)) {
          tasks.push((async() => {
            debug('downloading', url)
            await downloadTo(url, filepath)
            debug('downloaded', url)
          })())
        }

        const mode = typeof resolveMode === 'function' ? resolveMode(id, url) : resolveMode

        let newUrl: string

        if (mode === 'relative') {
          newUrl = posix.relative(dirname(id), `${dir}/${hash}`)
          if (newUrl[0] !== '.')
            newUrl = `./${newUrl}`
        }
        else {
          newUrl = `/@fs${dir}/${hash}`
        }

        s.overwrite(start, end, newUrl)
      }
    }

    if (!hasReplaced)
      return null

    if (tasks.length)
      await Promise.all(tasks)

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
      dir = posix.resolve(config.root, assetsDir)
      if (config.server.force)
        await emptyDir(dir)
      await ensureDir(dir)
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
