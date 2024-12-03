import {
  NewlineType,
  type SimpleExpressionNode,
  isSimpleIdentifier,
} from '@vue/compiler-core'
import type { CodegenContext } from '../generate'
import {
  IRDynamicPropsKind,
  type IRProp,
  type SetDynamicPropsIRNode,
  type SetInheritAttrsIRNode,
  type SetPropIRNode,
  type VaporHelper,
} from '../ir'
import { genExpression } from './expression'
import {
  type CodeFragment,
  DELIMITERS_ARRAY,
  DELIMITERS_OBJECT,
  INDENT_END,
  INDENT_START,
  LF,
  NEWLINE,
  genCall,
  genMulti,
} from './utils'
import {
  attributeCache,
  canSetValueDirectly,
  isHTMLGlobalAttr,
  isHTMLTag,
  isMathMLGlobalAttr,
  isMathMLTag,
  isSVGTag,
  isString,
  isSvgGlobalAttr,
  shouldSetAsAttr,
  toHandlerKey,
} from '@vue/shared'

// only the static key prop will reach here
export function genSetProp(
  oper: SetPropIRNode,
  context: CodegenContext,
): CodeFragment[] {
  const { vaporHelper, currentRenderEffect, shouldGenEffectDeps } = context
  const {
    prop: { key, values, modifier },
    tag,
  } = oper
  const { helperName, omitKey } = getRuntimeHelper(tag, key.content, modifier)
  let propValue = genPropValue(values, context)

  if (shouldGenEffectDeps()) {
    processValues(
      context,
      [propValue],
      currentRenderEffect!.operations.length === 1 ? '!==' : '===',
    )
  }

  return [
    NEWLINE,
    ...genCall(
      [vaporHelper(helperName), null],
      `n${oper.element}`,
      omitKey ? false : genExpression(key, context),
      propValue,
      // only `setClass` and `setStyle` need merge inherit attr
      oper.root && (helperName === 'setClass' || helperName === 'setStyle')
        ? 'true'
        : undefined,
    ),
  ]
}

// dynamic key props and v-bind="{}" will reach here
export function genDynamicProps(
  oper: SetDynamicPropsIRNode,
  context: CodegenContext,
): CodeFragment[] {
  const { vaporHelper, shouldGenEffectDeps } = context
  const values = oper.props.map(props =>
    Array.isArray(props)
      ? genLiteralObjectProps(props, context) // static and dynamic arg props
      : props.kind === IRDynamicPropsKind.ATTRIBUTE
        ? genLiteralObjectProps([props], context) // dynamic arg props
        : genExpression(props.value, context),
  ) // v-bind=""

  if (shouldGenEffectDeps()) {
    processValues(context, values)
  }

  return [
    NEWLINE,
    ...genCall(
      vaporHelper('setDynamicProps'),
      `n${oper.element}`,
      genMulti(DELIMITERS_ARRAY, ...values),
      oper.root && 'true',
    ),
  ]
}

function genLiteralObjectProps(
  props: IRProp[],
  context: CodegenContext,
): CodeFragment[] {
  return genMulti(
    DELIMITERS_OBJECT,
    ...props.map(prop => [
      ...genPropKey(prop, context),
      `: `,
      ...genPropValue(prop.values, context),
    ]),
  )
}

export function genPropKey(
  { key: node, modifier, runtimeCamelize, handler }: IRProp,
  context: CodegenContext,
): CodeFragment[] {
  const { helper } = context

  // static arg was transformed by v-bind transformer
  if (node.isStatic) {
    // only quote keys if necessary
    const keyName = handler ? toHandlerKey(node.content) : node.content
    return [
      [
        isSimpleIdentifier(keyName) ? keyName : JSON.stringify(keyName),
        NewlineType.None,
        node.loc,
      ],
    ]
  }

  let key = genExpression(node, context)
  if (runtimeCamelize) {
    key = genCall(helper('camelize'), key)
  }
  if (handler) {
    key = genCall(helper('toHandlerKey'), key)
  }
  return ['[', modifier && `${JSON.stringify(modifier)} + `, ...key, ']']
}

export function genPropValue(
  values: SimpleExpressionNode[],
  context: CodegenContext,
): CodeFragment[] {
  if (values.length === 1) {
    return genExpression(values[0], context)
  }
  return genMulti(
    DELIMITERS_ARRAY,
    ...values.map(expr => genExpression(expr, context)),
  )
}

export function genSetInheritAttrs(
  { staticProps, dynamicProps }: SetInheritAttrsIRNode,
  context: CodegenContext,
): CodeFragment[] {
  const { vaporHelper } = context

  // - `undefined` : no props
  // - `false`     : all props are static
  // - `string[]`  : list of props are dynamic
  // - `true`      : all props as dynamic
  const value =
    dynamicProps === true
      ? 'true'
      : dynamicProps.length
        ? genMulti(
            DELIMITERS_ARRAY,
            ...dynamicProps.map(p => JSON.stringify(p)),
          )
        : staticProps
          ? 'false'
          : null
  if (value == null) return []
  return [NEWLINE, ...genCall(vaporHelper('setInheritAttrs'), value)]
}

function getRuntimeHelper(
  tag: string,
  keyName: string,
  modifier: '.' | '^' | undefined,
) {
  const tagName = tag.toUpperCase()
  let helperName: VaporHelper
  let omitKey = false

  if (modifier) {
    if (modifier === '.') {
      const helper = getSpecialHelper(keyName, tagName)
      if (helper) {
        helperName = helper.name
        omitKey = helper.omitKey
      } else {
        helperName = 'setDOMProp'
        omitKey = false
      }
    } else {
      helperName = 'setAttr'
    }
  } else {
    const attrCacheKey = `${tagName}_${keyName}`
    const helper = getSpecialHelper(keyName, tagName)
    if (helper) {
      helperName = helper.name
      omitKey = helper.omitKey
    } else if (
      attributeCache[attrCacheKey] === undefined
        ? (attributeCache[attrCacheKey] = shouldSetAsAttr(tagName, keyName))
        : attributeCache[attrCacheKey]
    ) {
      helperName = 'setAttr'
    } else if (
      (isHTMLTag(tag) && isHTMLGlobalAttr(keyName)) ||
      (isSVGTag(tag) && isSvgGlobalAttr(keyName)) ||
      (isMathMLTag(tag) && isMathMLGlobalAttr(keyName))
    ) {
      helperName = 'setDOMProp'
    } else {
      helperName = 'setDynamicProp'
    }
  }
  return { helperName, omitKey }
}

const specialHelpers: Record<string, { name: VaporHelper; omitKey: boolean }> =
  {
    class: { name: 'setClass', omitKey: true },
    style: { name: 'setStyle', omitKey: true },
    innerHTML: { name: 'setHtml', omitKey: true },
    textContent: { name: 'setText', omitKey: true },
  }

const getSpecialHelper = (
  keyName: string,
  tagName: string,
): { name: VaporHelper; omitKey: boolean } | null => {
  // special case for 'value' property
  if (keyName === 'value' && canSetValueDirectly(tagName)) {
    return { name: 'setValue', omitKey: true }
  }

  return specialHelpers[keyName] || null
}

export function processValues(
  context: CodegenContext,
  values: CodeFragment[][],
  oper: '===' | '!==' = '!==',
): string[] {
  const conditions: string[] = []
  values.forEach(value => {
    const condition = processValue(context, value, oper)
    if (condition) conditions.push(...condition, ' && ')
  })

  return conditions.length > 0
    ? (context.currentRenderEffect!.conditions = [...new Set(conditions)])
    : []
}

function processValue(
  context: CodegenContext,
  values: CodeFragment[],
  oper: '===' | '!==' = '!==',
): string[] | undefined {
  const { currentRenderEffect } = context
  const { deps, overwrites, conditions } = currentRenderEffect!
  for (let frag of values) {
    if (
      !frag ||
      frag === NEWLINE ||
      frag === INDENT_START ||
      frag === INDENT_END ||
      frag === LF
    ) {
      continue
    }

    if (isString(frag)) frag = [frag]
    let [newName, , , idName] = frag
    if (idName) {
      idName = idName.replace(/\./g, '_')
      const overwrite = `(_${idName} = ${newName})`
      if (overwrites.includes(overwrite)) continue

      overwrites.push(overwrite)
      deps.push(idName)
      conditions.push(`_${idName} ${oper} ${newName}`)
      frag[0] = overwrite
    }
  }

  if (conditions.length > 0) {
    return [[...new Set(conditions)].join(' && ')]
  }
}
