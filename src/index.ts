import { extname, resolve, join } from 'path'
import { existsSync, mkdirSync, createWriteStream } from 'fs'
import http from 'http'
import https from 'https'
import type { Plugin } from 'vite'
import _debug from 'debug'
import md5 from 'blueimp-md5'

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
   * @default '.remote-assets'
   */
  assetsDir?: string

  /**
   * Rules to match urls to replace
   */
  rules?: RemoteAssetsRule[]
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
    assetsDir = '.remote-assets',
    rules = DefaultRules,
  } = options

  let dir: string = undefined!

  async function downloadTo(url: string, filepath: string): Promise<void> {
    const file = createWriteStream(filepath)
    const client = url.startsWith('https') ? https : http
    const request = client.get(url, res => res.pipe(file))

    return new Promise((resolve, reject) => {
      request.on('finish', () => {
        file.close()
        resolve()
      })
      request.on('error', (e) => {
        file.destroy()
        reject(e)
      })
    })
  }

  return {
    name: 'vite-plugin-remote-assets',
    enforce: 'pre',
    configResolved(config) {
      dir = resolve(config.publicDir, assetsDir)
      if (!existsSync(dir))
        mkdirSync(dir)
    },
    async transform(code) {
      let matched = false
      const tasks: Promise<void>[] = []

      for (const rule of rules) {
        code = code.replace(
          rule.match,
          (full, url) => {
            url = url || full
            if (!url || !isValidHttpUrl(url))
              return full

            matched = true
            const hash = md5(url) + rule.ext || extname(url)
            const filepath = join(dir, hash)

            debug('detected', url, hash)

            if (!existsSync(filepath)) {
              tasks.push((async() => {
                debug('downloading', url)
                await downloadTo(url, filepath)
                debug('downloaded', url)
              })())
            }

            return `/${assetsDir}/${hash}`
          },
        )
      }

      if (!matched)
        return

      if (tasks.length)
        await Promise.all(tasks)

      return code
    },
  } as Plugin
}

export default VitePluginRemoteAssets
