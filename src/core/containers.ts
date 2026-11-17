import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 本地容器化服务探测。
 *
 * 只负责「本机有没有在跑的容器、容器叫/镜像叫什么」，不认识任何具体平台——平台匹配词由
 * skill 资产（project-config/container-match）声明，本模块代码里不出现平台名。
 *
 * 探测顺序：docker ps → 失败退 podman ps → 两条都不可用则退回仓库根 compose 文件文本
 * （不解析 YAML，只把全文交给上层做包含匹配）→ 仍无结果返回 none。
 */

const PROBE_TIMEOUT_MS = 2000
/** 容器列表一行三列：镜像、容器名、端口映射（docker/podman 同一格式串）。 */
const PS_ARGS = ["ps", "--format", "{{.Image}}\t{{.Names}}\t{{.Ports}}"]

export interface ContainerRunResult {
  stdout: string
  stderr: string
  exitCode: number
  /** 运行器自身超时（按失败处理）。 */
  timedOut?: boolean
}

/** 可注入的运行器：默认实现走 node:child_process；测试注入伪造输出。 */
export interface ContainerRunner {
  run(cmd: string, args: string[]): Promise<ContainerRunResult>
}

export interface ContainerInfo {
  image: string
  name: string
  ports: string
}

export interface ContainerProbeResult {
  runtime: "docker" | "podman" | null
  containers: ContainerInfo[]
  /** compose 文件全文（按文件名排序）；运行时不可用时供上层做文本包含匹配。 */
  composeHits: string[]
  source: "runtime" | "compose" | "none"
}

const EMPTY_RESULT: ContainerProbeResult = {
  runtime: null,
  containers: [],
  composeHits: [],
  source: "none",
}

function createDefaultRunner(): ContainerRunner {
  return {
    run(cmd, args) {
      return new Promise((resolve) => {
        execFile(
          cmd,
          args,
          { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            const out = typeof stdout === "string" ? stdout : String(stdout ?? "")
            const err = typeof stderr === "string" ? stderr : String(stderr ?? "")
            if (!error) {
              resolve({ stdout: out, stderr: err, exitCode: 0 })
              return
            }
            // execFile 超时会杀进程并置 killed；不同平台下 code 可能是 ETIMEDOUT 或信号。
            const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
            const timedOut = e.killed === true || e.code === "ETIMEDOUT" || e.signal === "SIGTERM"
            const code = typeof e.code === "number" ? e.code : e.code === "ENOENT" ? 127 : 1
            resolve({ stdout: out, stderr: err, exitCode: timedOut ? 124 : code, timedOut })
          },
        )
      })
    },
  }
}

let runnerOverride: ContainerRunner | null = null

/** 测试注入：覆盖默认运行器；null 恢复真实子进程实现。 */
export function __setContainerRunner(runner: ContainerRunner | null): void {
  runnerOverride = runner
}

/** 探测命令是否成功（非零退出与超时都按失败处理，交给下一个候选）。 */
function succeeded(result: ContainerRunResult): boolean {
  return !result.timedOut && result.exitCode === 0
}

/** 解析 `ps --format "{{.Image}}\t{{.Names}}\t{{.Ports}}"` 输出；空行与非三列行跳过。 */
export function parseContainerList(stdout: string): ContainerInfo[] {
  const containers: ContainerInfo[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const [image = "", name = "", ports = ""] = raw.split("\t")
    if (image.trim().length === 0 && name.trim().length === 0) continue
    containers.push({ image: image.trim(), name: name.trim(), ports: ports.trim() })
  }
  return containers
}

/** 仓库根 compose 文件：docker-compose*.y*ml / compose*.y*ml（不递归、不解析）。 */
function findComposeFiles(repoRoot: string): string[] {
  if (!existsSync(repoRoot)) return []
  try {
    return readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(?:docker-)?compose[^/]*\.ya?ml$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function readComposeTexts(repoRoot: string, files: readonly string[]): string[] {
  const texts: string[] = []
  for (const file of files) {
    try {
      texts.push(readFileSync(join(repoRoot, file), "utf-8"))
    } catch {
      // 不可读文件按未命中处理，不阻断初始化
    }
  }
  return texts
}

/**
 * 探测本机容器运行时；两个运行时都不可用时退回 compose 文件文本。
 * repoRoot 用于定位 compose 文件（缺省不探测 compose）。
 */
export async function probeContainers(
  repoRoot: string,
  runner: ContainerRunner = runnerOverride ?? createDefaultRunner(),
): Promise<ContainerProbeResult> {
  for (const runtime of ["docker", "podman"] as const) {
    let result: ContainerRunResult
    try {
      result = await runner.run(runtime, PS_ARGS)
    } catch {
      continue // 运行器自身抛错按该运行时不可用处理
    }
    if (succeeded(result)) {
      return {
        runtime,
        containers: parseContainerList(result.stdout),
        composeHits: [],
        source: "runtime",
      }
    }
  }

  const composeHits = readComposeTexts(repoRoot, findComposeFiles(repoRoot))
  if (composeHits.length > 0) {
    return { runtime: null, containers: [], composeHits, source: "compose" }
  }
  return { ...EMPTY_RESULT }
}
