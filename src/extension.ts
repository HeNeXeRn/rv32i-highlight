import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// --- 1. 定义语义令牌类型 ---
const tokenTypes = ['definedLabel'];
const legend = new vscode.SemanticTokensLegend(tokenTypes);

export function activate(context: vscode.ExtensionContext) {
	// --- 2. 加载数据文件 ---
	const loadJson = (fileName: string) => {
		const filePath = path.join(context.extensionPath, 'data', fileName);
		if (!fs.existsSync(filePath)) return {};
		try {
			return JSON.parse(fs.readFileSync(filePath, 'utf8'));
		} catch (e) {
			return {};
		}
	};

	const instructionData = loadJson('instructions.json');
	const registerData = loadJson('registers.json');

	const instructionMap = new Map<string, any>();
	for (const cat in instructionData) {
		instructionData[cat].instructions?.forEach((inst: any) => instructionMap.set(inst.label, inst));
	}

	const registerMap = new Map<string, any>();
	for (const cat in registerData) {
		registerData[cat].registers?.forEach((reg: any) => {
			registerMap.set(reg.name, reg);
			if (reg.abi) registerMap.set(reg.abi, reg);
		});
	}

	// --- 3. 状态栏与内存估算 ---
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'editor.action.formatDocument';
	context.subscriptions.push(statusBarItem);

	const updateStatusBar = (document: vscode.TextDocument) => {
		if (document.languageId !== 'riscv') {
			statusBarItem.hide();
			return;
		}

		const text = document.getText();
		const lines = text.split(/\r?\n/);

		let labelCount = 0;
		let instCount = 0;

		lines.forEach(line => {
			const cleanLine = line.split('#')[0].trim();
			if (!cleanLine) return;

			if (cleanLine.endsWith(':')) {
				labelCount++;
			} else if (!cleanLine.startsWith('.')) {
				// 排除伪指令（以.开头），粗略统计汇编指令
				instCount++;
			}
		});

		const estimatedSize = instCount * 4; // 每条指令 4 字节
		statusBarItem.text = `$(chip) RISC-V: ${instCount} 指令 | ~${estimatedSize} Bytes`;
		statusBarItem.tooltip = `标签数: ${labelCount}\n估算大小: ${estimatedSize} 字节 (4字节/指令)\n点击格式化代码`;
		statusBarItem.show();
	};

	// --- 4. 诊断：标签重复与未定义检查 (修复 Windows \r 换行符 Bug) ---
	const diagnosticCollection = vscode.languages.createDiagnosticCollection('riscv');

	const updateDiagnostics = (document: vscode.TextDocument) => {
		if (document.languageId !== 'riscv') return;
		const diagnostics: vscode.Diagnostic[] = [];
		const text = document.getText();
		const definedLabels = new Map<string, vscode.Range>();

		const lines = text.split(/\r?\n/);

		// --- 第一步：扫描所有定义的标签 ---
		lines.forEach((lineText, lineIndex) => {
			// 1. 去掉注释
			// 2. 使用 trim() 移除 Windows 下末尾可能的 \r 以及前后空格
			const cleanLine = lineText.split('#')[0].trim();

			// 匹配 "label:" 格式
			const defMatch = /^([a-zA-Z_][a-zA-Z0-9_]*):/.exec(cleanLine);
			if (defMatch) {
				const label = defMatch[1];
				// 在原始行中精确定位标签位置（用于高亮显示错误）
				const startChar = lineText.indexOf(label);
				const range = new vscode.Range(lineIndex, startChar, lineIndex, startChar + label.length);

				if (definedLabels.has(label)) {
					diagnostics.push(new vscode.Diagnostic(range, `标签 "${label}" 已重复定义`, vscode.DiagnosticSeverity.Error));
				} else {
					definedLabels.set(label, range);
				}
			}
		});

		// --- 第二步：扫描指令中的跳转目标 ---
		// 正则解释：匹配跳转指令后的操作数部分，直到注释或换行
		const instRegex = /\b(j|jal|beq|bne|blt|bge|bltu|bgeu)\b([^#\r\n]+)/g;
		let match;
		while ((match = instRegex.exec(text)) !== null) {
			const matchIndex = match.index;
			const fullMatchText = match[0];
			const operandsText = match[2];

			// 排除掉在注释行内部的误触
			const lineAtPos = document.lineAt(document.positionAt(matchIndex));
			const commentIndex = lineAtPos.text.indexOf('#');
			if (commentIndex !== -1 && document.positionAt(matchIndex).character > commentIndex) {
				continue;
			}

			// 核心修复：切分操作数并对每一项进行 trim()，移除隐藏的 \r
			const words = operandsText.split(/[\t ,]+/)
				.map(w => w.trim())
				.filter(w => w.length > 0);

			if (words.length > 0) {
				// 在 RISC-V 汇编中，跳转目标通常是最后一个操作数
				const potentialLabel = words[words.length - 1];

				// 过滤掉：1. 寄存器  2. 数字/立即数  3. 已定义的标签
				const isRegister = registerMap.has(potentialLabel);
				const isNumber = /^-?\d+/.test(potentialLabel) || /^0x[0-9a-fA-F]+/.test(potentialLabel);
				const isDefined = definedLabels.has(potentialLabel);

				if (!isRegister && !isNumber && !isDefined) {
					// 计算该标签在当前匹配文本中的准确偏移量
					const labelOffset = fullMatchText.lastIndexOf(potentialLabel);
					const startPos = document.positionAt(matchIndex + labelOffset);
					const range = new vscode.Range(startPos, startPos.translate(0, potentialLabel.length));

					diagnostics.push(new vscode.Diagnostic(
						range,
						`未定义的标签: "${potentialLabel}"`,
						vscode.DiagnosticSeverity.Error
					));
				}
			}
		}

		diagnosticCollection.set(document.uri, diagnostics);
	};

	// --- 5. 语义令牌 Provider ---
	const semanticProvider: vscode.DocumentSemanticTokensProvider = {
		provideDocumentSemanticTokens(document: vscode.TextDocument) {
			const tokensBuilder = new vscode.SemanticTokensBuilder(legend);
			const text = document.getText();
			const definedLabels = new Set<string>();
			const defRegEx = /^[\t ]*([a-zA-Z_][a-zA-Z0-9_]*):/gm;
			let m;
			while ((m = defRegEx.exec(text))) definedLabels.add(m[1]);

			const wordRegEx = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
			while ((m = wordRegEx.exec(text))) {
				if (definedLabels.has(m[0])) {
					const pos = document.positionAt(m.index);
					if (document.lineAt(pos.line).text.substring(0, pos.character).includes('#')) continue;
					tokensBuilder.push(new vscode.Range(pos, pos.translate(0, m[0].length)), 'definedLabel');
				}
			}
			return tokensBuilder.build();
		}
	};

	// --- 6. 补全 Provider ---
	const completionProvider = vscode.languages.registerCompletionItemProvider('riscv', {
		provideCompletionItems(document) {
			const completions: vscode.CompletionItem[] = [];
			instructionMap.forEach(inst => {
				const item = new vscode.CompletionItem(inst.label, vscode.CompletionItemKind.Keyword);
				item.detail = inst.detail;
				item.documentation = new vscode.MarkdownString(inst.documentation);
				item.insertText = new vscode.SnippetString(inst.insertText);
				completions.push(item);
			});
			registerMap.forEach((reg, key) => {
				const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Variable);
				item.detail = `${reg.name} (${reg.description})`;
				completions.push(item);
			});
			return completions;
		}
	});

	// --- 7. 大纲与格式化 ---
	const symbolProvider = vscode.languages.registerDocumentSymbolProvider('riscv', {
		provideDocumentSymbols(document) {
			const symbols: vscode.DocumentSymbol[] = [];
			const labelRegex = /^[\t ]*([a-zA-Z_][a-zA-Z0-9_]*):/gm;
			let m;
			while ((m = labelRegex.exec(document.getText()))) {
				const range = new vscode.Range(document.positionAt(m.index), document.positionAt(m.index + m[0].length));
				symbols.push(new vscode.DocumentSymbol(m[1], "Label", vscode.SymbolKind.Function, range, range));
			}
			return symbols;
		}
	});

	const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider('riscv', {
		provideDocumentFormattingEdits(document: vscode.TextDocument) {
			const edits: vscode.TextEdit[] = [];
			const lineCount = document.lineCount;

			interface InstLine {
				type: 'instruction';
				range: vscode.Range;
				opcode: string;
				ops: string[];
				comment?: string;
				isJump: boolean;
			}

			interface OtherLine {
				type: 'label' | 'comment' | 'empty';
				range: vscode.Range;
				content: string;
				leadingSpaces: number;
			}

			type LineInfo = InstLine | OtherLine;
			let allLines: LineInfo[] = [];

			// --- 1. 解析阶段 ---
			for (let i = 0; i < lineCount; i++) {
				const line = document.lineAt(i);
				const text = line.text;
				const trimmed = text.trim();
				const commentIndex = text.indexOf('#');

				let content = commentIndex !== -1 ? text.substring(0, commentIndex).trim() : trimmed;
				let comment = commentIndex !== -1 ? text.substring(commentIndex).trim() : undefined;

				if (!trimmed) {
					allLines.push({ type: 'empty', range: line.range, content: '', leadingSpaces: 0 });
				} else if (content.endsWith(':')) {
					allLines.push({ type: 'label', range: line.range, content: content, leadingSpaces: 0 });
				} else if (content === "" && comment) {
					allLines.push({ type: 'comment', range: line.range, content: comment, leadingSpaces: text.search(/\S/) });
				} else {
					const firstSpace = content.search(/\s/);
					let opcode = content;
					let ops: string[] = [];
					if (firstSpace !== -1) {
						opcode = content.substring(0, firstSpace).trim();
						ops = content.substring(firstSpace).split(',').map(s => s.trim()).filter(s => s !== "");
					}
					const isJump = /^(jal|jalr)$/i.test(opcode);
					allLines.push({ type: 'instruction', range: line.range, opcode, ops, comment, isJump });
				}
			}

			// --- 2. 块对齐处理 ---
			let i = 0;
			let currentHasSeenLabel = false;

			while (i < allLines.length) {
				if (allLines[i].type === 'label') {
					currentHasSeenLabel = true;
				}

				if (allLines[i].type === 'instruction') {
					let j = i;
					let maxOpLen = 0;
					let maxOp1Len = 0, maxOp2Len = 0, maxOp3Len = 0;
					let maxLineLengthWithoutComment = 0;

					// 2.1 扫描块：计算指令名和操作数列宽
					while (j < allLines.length && allLines[j].type === 'instruction') {
						const line = allLines[j] as InstLine;
						maxOpLen = Math.max(maxOpLen, line.opcode.length);

						// 第一个操作数：无论是普通指令还是跳转指令，都参与对齐
						if (line.ops[0]) maxOp1Len = Math.max(maxOp1Len, line.ops[0].length);

						// 第二、三个操作数：只有非跳转指令参与对齐宽度计算
						if (!line.isJump) {
							if (line.ops[1]) maxOp2Len = Math.max(maxOp2Len, line.ops[1].length);
							if (line.ops[2]) maxOp3Len = Math.max(maxOp3Len, line.ops[2].length);
						}
						j++;
					}

					const baseIndent = currentHasSeenLabel ? 4 : 0;
					const indentStr = " ".repeat(baseIndent);

					// 2.2 预计算每一行的物理长度（用于注释对齐）
					for (let k = i; k < j; k++) {
						const line = allLines[k] as InstLine;
						let currentLen = baseIndent + maxOpLen + 1; // 缩进 + 指令名 + 后随空格

						if (line.isJump) {
							// 跳转指令：右对齐Op1 + ", " + 剩下的
							const op1 = (line.ops[0] || "").padStart(maxOp1Len, ' ');
							const rest = line.ops.slice(1).join(', ');
							currentLen += maxOp1Len + (rest ? 2 + rest.length : 0);
						} else {
							// 普通指令：Op1右对齐 + (Op2右对齐) + (Op3左对齐)
							currentLen += maxOp1Len;
							if (line.ops.length > 1) currentLen += 2 + maxOp2Len;
							if (line.ops.length > 2) currentLen += 2 + maxOp3Len;
						}
						maxLineLengthWithoutComment = Math.max(maxLineLengthWithoutComment, currentLen);
					}

					// 2.3 渲染输出
					for (let k = i; k < j; k++) {
						const line = allLines[k] as InstLine;
						let res = `${indentStr}${line.opcode.padEnd(maxOpLen, ' ')} `;

						// 无论什么指令，第一个操作数都右对齐
						const op1 = (line.ops[0] || "").padStart(maxOp1Len, ' ');
						res += op1;

						if (line.isJump) {
							// 跳转指令：第二个参数开始不再参与列宽对齐，直接跟在后面
							const rest = line.ops.slice(1).join(', ');
							if (rest) res += `, ${rest}`;
						} else {
							// 普通指令：Op2(右), Op3(左)
							const op2 = (line.ops[1] || "").padStart(maxOp2Len, ' ');
							const op3 = (line.ops[2] || "").padEnd(maxOp3Len, ' ');

							if (line.ops.length > 1) {
								res += `, ${op2}`;
							} else if (maxOp2Len > 0 || maxOp3Len > 0) {
								res += "  " + " ".repeat(maxOp2Len); // 占位保持对齐
							}

							if (line.ops.length > 2) {
								res += `, ${op3}`;
							}
						}

						if (line.comment) {
							res = res.padEnd(maxLineLengthWithoutComment + 2) + line.comment;
						}
						edits.push(vscode.TextEdit.replace(line.range, res));
					}
					i = j;
				} else {
					const line = allLines[i] as OtherLine;
					if (line.type === 'comment') {
						const newIndent = line.leadingSpaces > 0 ? Math.ceil(line.leadingSpaces / 4) * 4 : 0;
						edits.push(vscode.TextEdit.replace(line.range, " ".repeat(newIndent) + line.content));
					} else {
						edits.push(vscode.TextEdit.replace(line.range, line.content));
					}
					i++;
				}
			}
			return edits;
		}
	});

	// --- 8. 引用查找 ---
	const referenceProvider = vscode.languages.registerReferenceProvider('riscv', {
		provideReferences(document, position) {
			const range = document.getWordRangeAtPosition(position);
			if (!range) return null;
			const word = document.getText(range);
			const locations: vscode.Location[] = [];
			const regEx = new RegExp(`\\b${word}\\b`, 'g');
			const text = document.getText();
			let m;
			while ((m = regEx.exec(text))) {
				const pos = document.positionAt(m.index);
				if (document.lineAt(pos.line).text.substring(0, pos.character).includes('#')) continue;
				locations.push(new vscode.Location(document.uri, new vscode.Range(pos, pos.translate(0, word.length))));
			}
			return locations;
		}
	});

	// --- 8.5 Hover Provider (悬停显示说明、地址与偏移) ---
    const hoverProvider = vscode.languages.registerHoverProvider('riscv', {
        provideHover(document, position) {
            const range = document.getWordRangeAtPosition(position);
            if (!range) return null;
            const word = document.getText(range);
            const lineIndex = position.line;
            const lineText = document.lineAt(lineIndex).text;

            // --- 1. 预计算全文档地址映射 ---
            // 每次悬停时重新计算以保证实时性（小文档性能损耗可忽略）
            const { labelAddrMap, instAddrMap } = calculateAddresses(document);

            const markdown = new vscode.MarkdownString();
            markdown.isTrusted = true;

            // --- 2. 判定当前悬停内容的性质 ---
            
            // A. 检查是否是指令
            const inst = instructionMap.get(word);
            // B. 检查是否是寄存器
            const reg = registerMap.get(word);
            // C. 检查是否是标签定义 (word 后面紧跟冒号)
            const isLabelDef = new RegExp(`\\b${word}\\s*:`).test(lineText);
            // D. 检查是否在跳转指令的操作数中 (标签引用)
            const isLabelRef = labelAddrMap.has(word) && !isLabelDef;

            // --- 3. 构造显示内容 ---

            // 情况 1: 指令 (显示详细文档 + 16进制地址)
            if (inst) {
                const addr = instAddrMap.get(lineIndex);
                const addrStr = addr !== undefined ? `0x${addr.toString(16).toUpperCase()}` : "N/A";
                
                markdown.appendMarkdown(`**指令**: \`${word}\` (地址: \`${addrStr}\`)\n\n`);
                markdown.appendMarkdown(`> ${inst.detail}\n\n${inst.documentation}`);
                return new vscode.Hover(markdown);
            }

            // 情况 2: 寄存器
            if (reg) {
                markdown.appendMarkdown(`**寄存器**: ${reg.name} (${reg.abi || 'N/A'})\n\n`);
                markdown.appendMarkdown(`**描述**: ${reg.description}\n\n**用途**: ${reg.usage}`);
                return new vscode.Hover(markdown);
            }

            // 情况 3: 标签定义处 (显示标签绝对地址)
            if (isLabelDef && labelAddrMap.has(word)) {
                const addr = labelAddrMap.get(word);
                markdown.appendMarkdown(`**标签定义**: \`${word}\`\n\n`);
                markdown.appendMarkdown(`**内存地址**: \`0x${addr?.toString(16).toUpperCase()}\``);
                return new vscode.Hover(markdown);
            }

            // 情况 4: 标签引用处 (显示相对距离)
            if (isLabelRef) {
                const targetAddr = labelAddrMap.get(word)!;
                const currentInstAddr = instAddrMap.get(lineIndex);

                markdown.appendMarkdown(`**标签引用**: \`${word}\`\n\n`);
                markdown.appendMarkdown(`**目标地址**: \`0x${targetAddr.toString(16).toUpperCase()}\`\n\n`);

                if (currentInstAddr !== undefined) {
                    const offset = targetAddr - currentInstAddr;
                    const sign = offset >= 0 ? "+" : "";
                    markdown.appendMarkdown(`**相对偏移**: \`${sign}${offset}\` bytes (PC ${sign}${offset})`);
                }
                return new vscode.Hover(markdown);
            }

            return null;
        }
    });

    /**
     * 辅助函数：扫描文档并计算地址映射
     */
    function calculateAddresses(document: vscode.TextDocument) {
        const labelAddrMap = new Map<string, number>();
        const instAddrMap = new Map<number, number>(); // lineIndex -> address
        let currentAddress = 0;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text.split('#')[0].trim();
            if (!line) continue;

            // 处理标签定义
            const labelMatch = /^([a-zA-Z_][a-zA-Z0-9_]*):/.exec(line);
            if (labelMatch) {
                const labelName = labelMatch[1];
                labelAddrMap.set(labelName, currentAddress);
                // 注意：同一行可能既有标签又有指令，例如 "loop: add x1, x2, x3"
                const remaining = line.substring(labelMatch[0].length).trim();
                if (remaining && !remaining.startsWith('.')) {
                    instAddrMap.set(i, currentAddress);
                    currentAddress += 4;
                }
            } 
            // 处理普通指令 (排除伪指令 .section, .global 等)
            else if (!line.startsWith('.')) {
                instAddrMap.set(i, currentAddress);
                currentAddress += 4;
            }
        }
        return { labelAddrMap, instAddrMap };
    }

	// --- 9. 注册监听与 Provider ---
	context.subscriptions.push(
		diagnosticCollection,
		vscode.languages.registerDocumentSemanticTokensProvider({ language: 'riscv' }, semanticProvider, legend),
		completionProvider,
		symbolProvider,
		formattingProvider,
		referenceProvider,
		hoverProvider,
		vscode.window.onDidChangeActiveTextEditor(e => { if (e) updateStatusBar(e.document); }),
		vscode.workspace.onDidChangeTextDocument(e => {
			updateDiagnostics(e.document);
			updateStatusBar(e.document);
		}),
		vscode.workspace.onDidOpenTextDocument(doc => {
			updateDiagnostics(doc);
			updateStatusBar(doc);
		})
	);

	if (vscode.window.activeTextEditor) {
		updateDiagnostics(vscode.window.activeTextEditor.document);
		updateStatusBar(vscode.window.activeTextEditor.document);
	}
}

export function deactivate() { }