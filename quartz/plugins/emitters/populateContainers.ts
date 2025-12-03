import fs from "fs"
import { globby } from "globby"
import { type Element, type Root } from "hast"
import { fromHtml } from "hast-util-from-html"
import { toHtml } from "hast-util-to-html"
import { h } from "hastscript"
import { visit } from "unist-util-visit"

import { minFaviconCount, specialFaviconPaths } from "../../components/constants"
import { joinSegments, type FilePath, type FullSlug } from "../../util/path"
import { getFaviconCounts } from "../transformers/countFavicons"
import {
  createFaviconElement,
  getFaviconUrl,
  transformUrl,
  DEFAULT_PATH,
  urlCache,
  shouldIncludeFavicon,
} from "../transformers/linkfavicons"
import { createWinstonLogger } from "../transformers/logger_utils"
import { hasClass } from "../transformers/utils"
import { type QuartzEmitterPlugin } from "../types"

const logger = createWinstonLogger("populateContainers")

const TEST_PAGE_SLUG = "test-page" as FullSlug
const DESIGN_PAGE_SLUG = "design" as FullSlug

// NEW: Safe file existence check
const fileExists = (path: string): boolean => {
  try {
    return fs.existsSync(path)
  } catch {
    return false
  }
}

/**
 * Finds an element in the HAST tree by its ID attribute.
 */
export const findElementById = (root: Root, id: string): Element | null => {
  let found: Element | null = null
  visit(root, "element", (node) => {
    if (node.properties?.id === id) {
      found = node
    }
  })
  return found
}

/**
 * Finds all elements in the HAST tree by class name.
 */
export const findElementsByClass = (root: Root, className: string): Element[] => {
  const found: Element[] = []
  visit(root, "element", (node) => {
    if (hasClass(node, className)) {
      found.push(node)
    }
  })
  return found
}

export type ContentGenerator = () => Promise<Element[]>

export const generateConstantContent = (value: string | number): ContentGenerator => {
  return async (): Promise<Element[]> => {
    return [h("span", String(value))]
  }
}

export const generateTestCountContent = (): ContentGenerator => {
  return async (): Promise<Element[]> => {
    const testFiles = await globby("**/*.test.{ts,tsx}", {
      ignore: ["node_modules/**", "coverage/**", "public/**"],
    })
    const count = testFiles.length
    return [h("span", `${count} test files`)]
  }
}

const addPngExtension = (path: string): string => {
  if (path.startsWith("http") || path.includes(".svg") || path.includes(".ico")) {
    return path
  }
  return `${path}.png`
}

const checkCdnSvgs = async (pngPaths: string[]): Promise<void> => {
  await Promise.all(
    pngPaths.map(async (pngPath) => {
      const svgUrl = `https://assets.turntrout.com${pngPath.replace(".png", ".svg")}`
      try {
        const response = await fetch(svgUrl)
        if (response.ok) {
          urlCache.set(pngPath, svgUrl)
        }
      } catch {
        // ignore
      }
    }),
  )
}

export const generateSiteFaviconContent = (): ContentGenerator => {
  return async (): Promise<Element[]> => {
    const faviconElement = createFaviconElement(specialFaviconPaths.turntrout)
    return [h("span", { className: "favicon-span" }, [faviconElement])]
  }
}

export const generateFaviconContent = (): ContentGenerator => {
  return async (): Promise<Element[]> => {
    const faviconCounts = getFaviconCounts()
    logger.info(`Got ${faviconCounts.size} favicon counts for table generation`)

    const pngPathsToCheck = Array.from(faviconCounts.keys())
      .map(addPngExtension)
      .map(transformUrl)
      .filter((path) => path !== DEFAULT_PATH && path.endsWith(".png"))
      .filter((path) => !urlCache.has(path) || urlCache.get(path) === DEFAULT_PATH)

    await checkCdnSvgs(pngPathsToCheck)

    const validFavicons = Array.from(faviconCounts.entries())
      .map(([pathWithoutExt, count]) => {
        const pathWithExt = addPngExtension(pathWithoutExt)
        const transformedPath = transformUrl(pathWithExt)
        if (transformedPath === DEFAULT_PATH) return null

        const url = getFaviconUrl(transformedPath)
        if (url === DEFAULT_PATH) return null

        if (!shouldIncludeFavicon(url, pathWithoutExt, faviconCounts)) return null

        return { url, count } as const
      })
      .filter((item): item is { url: string; count: number } => item !== null)
      .sort((a, b) => b.count - a.count)

    logger.info(`After filtering, ${validFavicons.length} valid favicons for table`)

    const tableRows: Element[] = [
      h("tr", [h("th", "Lowercase"), h("th", "Punctuation"), h("th", "Exclamation")]),
    ]

    for (const { url } of validFavicons) {
      const faviconElement = createFaviconElement(url)
      tableRows.push(
        h("tr", [
          h("td", [h("span", ["test", faviconElement])]),
          h("td", [h("span", ["test.", faviconElement])]),
          h("td", [h("span", ["test!", faviconElement])]),
        ]),
      )
    }

    return [h("table", { class: "center-table-headings" }, tableRows)]
  }
}

export interface ElementPopulatorConfig {
  id?: string
  className?: string
  generator: ContentGenerator
}

export const populateElements = async (
  htmlPath: string,
  configs: ElementPopulatorConfig[],
): Promise<FilePath[]> => {
  const html = fs.readFileSync(htmlPath, "utf-8")
  const root = fromHtml(html)
  let modified = false

  for (const config of configs) {
    if (config.id && config.className) {
      throw new Error("Config cannot have both id and className")
    }

    if (config.id) {
      const element = findElementById(root, config.id)
      if (!element) {
        logger.warn(`No element with id "${config.id}" found in ${htmlPath}`)
        continue
      }

      const content = await config.generator()
      element.children = content
      modified = true
    } else if (config.className) {
      const elements = findElementsByClass(root, config.className)
      if (elements.length === 0) {
        logger.warn(`No elements with class "${config.className}" found in ${htmlPath}`)
        continue
      }

      logger.debug(`Populating ${elements.length} element(s) with class .${config.className}`)
      const content = await config.generator()
      for (const element of elements) {
        element.children = content
      }
      modified = true
      logger.debug(`Added ${content.length} elements to each .${config.className}`)
    } else {
      throw new Error("Config missing both id and className")
    }
  }

  if (modified) {
    fs.writeFileSync(htmlPath, toHtml(root), "utf-8")
    return [htmlPath as FilePath]
  }

  return []
}

/**
 * Emitter that populates containers on test & design pages.
 */
export const PopulateContainers: QuartzEmitterPlugin = () => {
  return {
    name: "PopulateContainers",
    getQuartzComponents() {
      return []
    },
    async emit(ctx) {
      const testPagePath = joinSegments(ctx.argv.output, `${TEST_PAGE_SLUG}.html`)
      const designPagePath = joinSegments(ctx.argv.output, `${DESIGN_PAGE_SLUG}.html`)

      const testPageFiles = fileExists(testPagePath)
        ? await populateElements(testPagePath, [
            {
              id: "populate-favicon-container",
              generator: generateFaviconContent(),
            },
          ])
        : []

      const designPageFiles = fileExists(designPagePath)
        ? await populateElements(designPagePath, [
            {
              className: "populate-site-favicon",
              generator: generateSiteFaviconContent(),
            },
            {
              id: "populate-favicon-threshold",
              generator: generateConstantContent(minFaviconCount),
            },
          ])
        : []

      return [...testPageFiles, ...designPageFiles]
    },
  }
}
