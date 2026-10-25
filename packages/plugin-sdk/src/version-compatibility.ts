/** 严格解析 SemVer 三元组，返回按大小比较所需的整数。 */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  if (!match) return null
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return parts.every(Number.isSafeInteger) ? parts : null
}

/** 比较两个已解析版本。 */
function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** 把单个比较表达式转换为上下界。 */
function parseComparator(value: string): {
  lower?: readonly number[]
  lowerInclusive?: boolean
  upper?: readonly number[]
  upperInclusive?: boolean
} | null {
  if (value === '*') return {}
  const match = /^(\^|~|>=|<=|>|<|=)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(value)
  if (!match) return null
  const operator = match[1] ?? '='
  const version = parseVersion(match[2]!)
  if (!version) return null
  if (operator === '>=') return { lower: version, lowerInclusive: true }
  if (operator === '>') return { lower: version, lowerInclusive: false }
  if (operator === '<=') return { upper: version, upperInclusive: true }
  if (operator === '<') return { upper: version, upperInclusive: false }
  if (operator === '=') return { lower: version, lowerInclusive: true, upper: version, upperInclusive: true }
  const upper: [number, number, number] = operator === '~'
    ? [version[0], version[1] + 1, 0]
    : version[0] > 0
      ? [version[0] + 1, 0, 0]
      : version[1] > 0
        ? [0, version[1] + 1, 0]
        : [0, 0, version[2] + 1]
  return { lower: version, lowerInclusive: true, upper, upperInclusive: false }
}

/** 判断宿主版本是否满足一个复合版本范围。 */
function matchesRange(version: readonly number[], value: string): boolean {
  const comparators = value.trim().split(/\s+/)
  if (comparators.length === 0 || comparators.some(item => !item)) return false
  let lower: readonly number[] | undefined
  let lowerInclusive = true
  let upper: readonly number[] | undefined
  let upperInclusive = true
  for (const comparator of comparators) {
    const parsed = parseComparator(comparator)
    if (!parsed) return false
    if (parsed.lower && (!lower || compareVersion(parsed.lower, lower) > 0)) {
      lower = parsed.lower
      lowerInclusive = parsed.lowerInclusive ?? true
    }
    if (parsed.upper && (!upper || compareVersion(parsed.upper, upper) < 0)) {
      upper = parsed.upper
      upperInclusive = parsed.upperInclusive ?? true
    }
  }
  if (lower) {
    const comparison = compareVersion(version, lower)
    if (comparison < 0 || (comparison === 0 && !lowerInclusive)) return false
  }
  if (upper) {
    const comparison = compareVersion(version, upper)
    if (comparison > 0 || (comparison === 0 && !upperInclusive)) return false
  }
  return true
}

/**
 * 判断宿主 SemVer 是否满足插件声明范围。
 * 支持 `*`、精确版本、`^`、`~`、比较符和空格组合的 OR 分支；无效范围 fail closed。
 */
export function isPluginHostApiCompatible(range: string, hostVersion: string): boolean {
  const version = parseVersion(hostVersion)
  if (!version || typeof range !== 'string' || !range.trim()) return false
  const alternatives = range.split('||')
  if (alternatives.some(value => !value.trim())) return false
  return alternatives.some(value => matchesRange(version, value))
}
