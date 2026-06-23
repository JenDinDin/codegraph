import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, NodeKind } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

type Scope = {
  kind: 'class' | 'function' | 'method' | 'properties' | 'methods' | 'control';
  nodeId?: string;
  name?: string;
  className?: string;
  startLine: number;
};

const CONTROL_START_RE = /^\s*(?:if|for|parfor|while|switch|try|spmd)\b/i;
const END_RE = /^\s*end\s*(?:%.*)?$/i;
const KEYWORDS = new Set([
  'arguments', 'break', 'case', 'catch', 'classdef', 'continue', 'else',
  'elseif', 'end', 'for', 'function', 'global', 'if', 'methods', 'otherwise',
  'parfor', 'persistent', 'properties', 'return', 'spmd', 'switch', 'try',
  'while',
]);

/**
 * Lightweight MATLAB extractor.
 *
 * MATLAB's `.m` extension conflicts with Objective-C, and the npm grammar does
 * not ship a WASM build. This extractor covers the symbol/call shapes agents
 * need most: script files, local functions, classdef blocks, methods,
 * properties, top-level assignments, and ordinary function calls.
 */
export class MatlabExtractor {
  private filePath: string;
  private lines: string[];
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private nodeById = new Map<string, Node>();
  private functionNodes: Node[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.lines = source.split('\n');
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createNode('file', this.basename(), 1, this.lines.length, 0, this.lines[this.lines.length - 1]?.length || 0, this.filePath);
      const stack: Scope[] = [{ kind: 'control', nodeId: fileNode.id, startLine: 1 }];

      for (let i = 0; i < this.lines.length; i++) {
        const lineNum = i + 1;
        const raw = this.lines[i]!;
        const code = this.stripComment(raw).trim();
        if (!code) continue;

        if (END_RE.test(code)) {
          this.closeScope(stack.pop(), lineNum);
          if (stack.length === 0) stack.push({ kind: 'control', nodeId: fileNode.id, startLine: 1 });
          continue;
        }

        const cls = this.parseClassdef(code);
        if (cls) {
          const node = this.createNode('class', cls.name, lineNum, lineNum, raw.indexOf('classdef'), raw.length, `${this.filePath}::${cls.name}`);
          this.addContains(this.currentNodeId(stack), node.id);
          if (cls.parent) {
            this.addReference(node.id, cls.parent, 'extends', lineNum, raw.indexOf(cls.parent));
          }
          stack.push({ kind: 'class', nodeId: node.id, name: cls.name, className: cls.name, startLine: lineNum });
          continue;
        }

        const block = this.parseMemberBlock(code);
        if (block) {
          stack.push({ kind: block, className: this.currentClassName(stack), startLine: lineNum });
          continue;
        }

        const fn = this.parseFunction(code);
        if (fn) {
          const className = this.currentClassName(stack);
          const inMethods = stack.some((s) => s.kind === 'methods');
          const kind: NodeKind = className && inMethods ? 'method' : 'function';
          const simpleName = fn.name.split('.').pop() || fn.name;
          const qualifiedName = className && kind === 'method'
            ? `${this.filePath}::${className}.${simpleName}`
            : `${this.filePath}::${simpleName}`;
          const node = this.createNode(kind, simpleName, lineNum, lineNum, raw.indexOf('function'), raw.length, qualifiedName, fn.signature);
          this.functionNodes.push(node);
          this.addContains(this.currentNodeId(stack), node.id);
          stack.push({ kind, nodeId: node.id, name: simpleName, className, startLine: lineNum });
          this.extractCallsFromLine(raw, lineNum, node.id);
          continue;
        }

        if (CONTROL_START_RE.test(code)) {
          stack.push({ kind: 'control', startLine: lineNum });
        }

        if (this.inPropertiesBlock(stack)) {
          const prop = this.parseProperty(code);
          if (prop) {
            const parent = this.currentClassNodeId(stack) || this.currentNodeId(stack);
            const className = this.currentClassName(stack);
            const node = this.createNode('property', prop, lineNum, lineNum, raw.indexOf(prop), raw.length, className ? `${this.filePath}::${className}.${prop}` : `${this.filePath}::${prop}`);
            this.addContains(parent, node.id);
          }
          continue;
        }

        const assignment = this.parseAssignment(code);
        if (assignment && this.currentCallableNodeId(stack) === fileNode.id) {
          const node = this.createNode(this.isConstantName(assignment) ? 'constant' : 'variable', assignment, lineNum, lineNum, raw.indexOf(assignment), raw.length, `${this.filePath}::${assignment}`);
          this.addContains(fileNode.id, node.id);
        }

        this.extractCallsFromLine(raw, lineNum, this.currentCallableNodeId(stack));
      }

      for (const scope of stack) this.closeScope(scope, this.lines.length);
    } catch (error) {
      this.errors.push({
        message: `MATLAB extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createNode(kind: NodeKind, name: string, startLine: number, endLine: number, startColumn: number, endColumn: number, qualifiedName: string, signature?: string): Node {
    const node: Node = {
      id: generateNodeId(this.filePath, kind, qualifiedName, startLine),
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'matlab',
      startLine,
      endLine,
      startColumn: Math.max(0, startColumn),
      endColumn: Math.max(0, endColumn),
      signature,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.nodeById.set(node.id, node);
    return node;
  }

  private addContains(parentId: string | undefined, childId: string): void {
    if (!parentId || parentId === childId) return;
    this.edges.push({ source: parentId, target: childId, kind: 'contains' });
  }

  private addReference(fromNodeId: string, referenceName: string, referenceKind: UnresolvedReference['referenceKind'], line: number, column: number): void {
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind,
      line,
      column: Math.max(0, column),
      filePath: this.filePath,
      language: 'matlab',
    });
  }

  private closeScope(scope: Scope | undefined, endLine: number): void {
    if (!scope?.nodeId || scope.kind === 'control') return;
    const node = this.nodeById.get(scope.nodeId);
    if (node && node.endLine < endLine) {
      node.endLine = endLine;
      node.endColumn = this.lines[endLine - 1]?.length || node.endColumn;
    }
  }

  private basename(): string {
    return this.filePath.split(/[\\/]/).pop() || this.filePath;
  }

  private stripComment(line: string): string {
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if ((ch === "'" || ch === '"') && line[i - 1] !== '\\') {
        if (quote === ch) quote = null;
        else if (!quote) quote = ch;
      }
      if (ch === '%' && !quote) return line.slice(0, i);
    }
    return line;
  }

  private parseClassdef(code: string): { name: string; parent?: string } | null {
    const match = code.match(/^classdef(?:\s*\([^)]*\))?\s+([A-Za-z]\w*)(?:\s*<\s*([A-Za-z]\w*(?:\.[A-Za-z]\w*)?))?/);
    return match ? { name: match[1]!, parent: match[2] } : null;
  }

  private parseMemberBlock(code: string): 'methods' | 'properties' | null {
    if (/^methods\b/i.test(code)) return 'methods';
    if (/^properties\b/i.test(code)) return 'properties';
    return null;
  }

  private parseFunction(code: string): { name: string; signature?: string } | null {
    if (!/^\s*function\b/i.test(code)) return null;
    const rest = code.replace(/^\s*function\b/i, '').trim();
    const afterOutput = rest.includes('=') ? rest.slice(rest.indexOf('=') + 1).trim() : rest;
    const match = afterOutput.match(/^([A-Za-z]\w*(?:\.[A-Za-z]\w*)?)\s*(\([^)]*\))?/);
    if (!match) return null;
    return { name: match[1]!, signature: match[2] };
  }

  private parseProperty(code: string): string | null {
    if (/^(?:methods|properties|events|enumeration|arguments)\b/i.test(code)) return null;
    const match = code.match(/^([A-Za-z]\w*)\b(?!\s*\()/);
    return match ? match[1]! : null;
  }

  private parseAssignment(code: string): string | null {
    const match = code.match(/^([A-Za-z]\w*)\s*=(?!=)/);
    return match ? match[1]! : null;
  }

  private extractCallsFromLine(raw: string, line: number, fromNodeId: string): void {
    const code = this.stripComment(raw);
    const callRe = /\b([A-Za-z]\w*(?:\.[A-Za-z]\w*)*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = callRe.exec(code)) !== null) {
      const name = match[1]!;
      const simple = name.split('.').pop() || name;
      if (KEYWORDS.has(simple.toLowerCase())) continue;
      if (this.isDefinitionNameAt(code, match.index)) continue;
      this.addReference(fromNodeId, name, 'calls', line, match.index);
    }
  }

  private isDefinitionNameAt(code: string, index: number): boolean {
    return /^\s*function\b/i.test(code.slice(0, index));
  }

  private currentNodeId(stack: Scope[]): string | undefined {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.nodeId) return stack[i]!.nodeId;
    }
    return undefined;
  }

  private currentCallableNodeId(stack: Scope[]): string {
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i]!;
      if (s.nodeId && (s.kind === 'function' || s.kind === 'method' || s.kind === 'control')) return s.nodeId;
    }
    return this.nodes[0]!.id;
  }

  private currentClassName(stack: Scope[]): string | undefined {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.className) return stack[i]!.className;
      if (stack[i]!.kind === 'class') return stack[i]!.name;
    }
    return undefined;
  }

  private currentClassNodeId(stack: Scope[]): string | undefined {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.kind === 'class' && stack[i]!.nodeId) return stack[i]!.nodeId;
    }
    return undefined;
  }

  private inPropertiesBlock(stack: Scope[]): boolean {
    return stack.some((s) => s.kind === 'properties');
  }

  private isConstantName(name: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(name);
  }
}
