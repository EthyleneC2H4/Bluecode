import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { command } from "./live-process"
import type { BusinessServiceStarter } from "./business-acceptance"

export function dockerBusinessService(image: string): BusinessServiceStarter {
  return async workdir => {
    const name = `bluecode-check-${randomUUID().replaceAll("-", "").slice(0, 20)}`
    const cwd = resolve(workdir)
    const result = await command(["docker", "run", "-d", "--rm", "--name", name, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--pids-limit=128", "--memory=1g", "--network=bridge", "-p", "127.0.0.1::3000", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
      "--mount", `type=bind,source=${cwd},target=/workspace`, "-e", "PORT=3000", image, "bun", "src/server.ts"], cwd, {}, 15000)
    if (result.code !== 0) throw Error(`Verifier container failed to start: ${result.stderr.slice(-500)}`)
    const close = async () => { await command(["docker", "rm", "-f", name], cwd, {}, 10000) }
    try {
      const mapping = await command(["docker", "port", name, "3000/tcp"], cwd, {}, 10000)
      const match = mapping.stdout.match(/127\.0\.0\.1:(\d+)/)
      if (mapping.code !== 0 || !match) throw Error(`Verifier port missing: ${mapping.stderr.slice(-300)}`)
      const base = `http://127.0.0.1:${match[1]}`
      let healthy = false
      for (let attempt = 0; attempt < 30; attempt++) {
        try { healthy = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) })).ok } catch { /* startup */ }
        if (healthy) break
        await Bun.sleep(100)
      }
      if (!healthy) throw Error("Verifier service failed health check")
      return { base, close }
    } catch (error) { await close(); throw error }
  }
}
