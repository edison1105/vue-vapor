import { isArray } from '@vue/shared'
import { type ComponentInternalInstance, componentKey } from './component'

export const fragmentKey: unique symbol = Symbol(__DEV__ ? `fragmentKey` : ``)

export type Block = Node | Fragment | ComponentInternalInstance | Block[]
export type Fragment = {
  nodes: Block
  anchor?: Node
  [fragmentKey]: true
}

/*! #__NO_SIDE_EFFECTS__ */
export function normalizeBlock(block: Block): Node[] {
  const nodes: Node[] = []
  if (block instanceof Node) {
    nodes.push(block)
  } else if (isArray(block)) {
    block.forEach(child => nodes.push(...normalizeBlock(child)))
  } else if (componentKey in block) {
    nodes.push(...normalizeBlock(block.block!))
  } else if (block) {
    nodes.push(...normalizeBlock(block.nodes))
    block.anchor && nodes.push(block.anchor)
  }
  return nodes
}

export function findFirstRootElement(
  instance: ComponentInternalInstance,
): Element | undefined {
  const element = getFirstNode(instance.block)
  return element instanceof Element ? element : undefined
}

export function getFirstNode(block: Block | null): Node | undefined {
  if (!block || componentKey in block) return
  if (block instanceof Node) return block
  if (isArray(block)) {
    if (block.length === 1) {
      return getFirstNode(block[0])
    }
  } else {
    return getFirstNode(block.nodes)
  }
}

export function isValidBlock(block: Block): boolean {
  return (
    normalizeBlock(block).filter(node => !(node instanceof Comment)).length > 0
  )
}
