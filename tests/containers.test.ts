import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __setContainerRunner,
  parseContainerList,
  probeContainers,
  type ContainerRunner,
} from "../src/core/containers"

const created: string[] = []

afterEach(() => {
  __setContainerRunner(null)
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

function mkTmp(prefix = "opx-containers-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** 按命令名前缀分派的伪造运行器：未声明的命令一律按「不可用」失败。 */
function fakeRunner(table: Record<string, { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean }>): ContainerRunner {
  return {
    async run(cmd) {
      const hit = table[cmd]
      if (!hit) return { stdout: "", stderr: `${cmd}: not found`, exitCode: 127 }
      return {
        stdout: hit.stdout ?? "",
        stderr: hit.stderr ?? "",
        exitCode: hit.exitCode ?? 0,
        ...(hit.timedOut === undefined ? {} : { timedOut: hit.timedOut }),
      }
    },
  }
}

describe("parseContainerList", () => {
  test("按 tab 解析镜像/容器名/端口，空行跳过", () => {
    const stdout = "sonarqube:9.9-community\tsonarqube\t0.0.0.0:9000->9000/tcp\n\npostgres:16\tpg\t5432/tcp\n"
    expect(parseContainerList(stdout)).toEqual([
      { image: "sonarqube:9.9-community", name: "sonarqube", ports: "0.0.0.0:9000->9000/tcp" },
      { image: "postgres:16", name: "pg", ports: "5432/tcp" },
    ])
  })
})

describe("probeContainers", () => {
  test("docker 成功：返回 runtime=docker 与容器清单", async () => {
    const repo = mkTmp()
    const probe = await probeContainers(repo, fakeRunner({
      docker: { stdout: "sonarqube:9.9-community\tsonarqube\t0.0.0.0:9000->9000/tcp\n" },
    }))
    expect(probe.source).toBe("runtime")
    expect(probe.runtime).toBe("docker")
    expect(probe.containers).toHaveLength(1)
    expect(probe.containers[0].image).toBe("sonarqube:9.9-community")
    expect(probe.composeHits).toEqual([])
  })

  test("docker 失败退 podman：返回 runtime=podman", async () => {
    const repo = mkTmp()
    const probe = await probeContainers(repo, fakeRunner({
      docker: { stderr: "Cannot connect to the Docker daemon", exitCode: 1 },
      podman: { stdout: "sonarqube:10\tsonarqube\t9000/tcp\n" },
    }))
    expect(probe.source).toBe("runtime")
    expect(probe.runtime).toBe("podman")
    expect(probe.containers[0].name).toBe("sonarqube")
  })

  test("超时按失败处理：docker 超时后继续尝试 podman", async () => {
    const repo = mkTmp()
    const probe = await probeContainers(repo, fakeRunner({
      docker: { stdout: "", timedOut: true, exitCode: 124 },
      podman: { stdout: "sonarqube:10\tsonarqube\t9000/tcp\n" },
    }))
    expect(probe.runtime).toBe("podman")
    expect(probe.containers).toHaveLength(1)
  })

  test("两个运行时都不可用：退回仓库根 compose 文本", async () => {
    const repo = mkTmp()
    writeFileSync(join(repo, "docker-compose.yml"), "services:\n  sonarqube:\n    image: sonarqube:9.9\n")
    writeFileSync(join(repo, "compose.override.yaml"), "services:\n  db:\n    image: postgres:16\n")
    const probe = await probeContainers(repo, fakeRunner({}))
    expect(probe.runtime).toBeNull()
    expect(probe.source).toBe("compose")
    expect(probe.containers).toEqual([])
    expect(probe.composeHits).toHaveLength(2)
    expect(probe.composeHits.join("\n")).toContain("sonarqube:9.9")
  })

  test("全失败且无 compose：返回 none", async () => {
    const repo = mkTmp()
    const probe = await probeContainers(repo, fakeRunner({}))
    expect(probe).toEqual({ runtime: null, containers: [], composeHits: [], source: "none" })
  })

  test("compose 文件目录不存在时不抛错", async () => {
    const probe = await probeContainers(join(mkTmp(), "missing"), fakeRunner({}))
    expect(probe.source).toBe("none")
  })
})
