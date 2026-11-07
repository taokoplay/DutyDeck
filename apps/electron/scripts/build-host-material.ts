import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureBundleSet } from '../src/main/lib/host-build-identity'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'

/** 在所有bundle完成后生成诊断材料清单。它不是签名、hostBuildSha256或执行验证记录。 */
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const material = captureBundleSet(dist)
writeJsonFileAtomic(resolve(dist, 'host-bundle-material.json'), material)
console.log(`[host-build] bundle-set ${material.sha256}，${material.files.length} 项；不覆盖external/extraResources，不授予验证通过。`)
