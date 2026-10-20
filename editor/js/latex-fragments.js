/* =========================================================================
 * LaTeX fragment parser (shared between Formula Builder and Formula Editor).
 * Splits a LaTeX formula into draggable fragments; the original order of
 * fragments is the correct answer of the test.
 * IMPORTANT: both apps are deployed as separate GitHub Pages trees, so each has its own
 * copy of this file. The two copies MUST stay identical:
 *   ../js/latex-fragments.js  (Formula Builder)
 *   js/latex-fragments.js     (Formula Editor)
 * ========================================================================= */
(function (global) {
    'use strict';

    const OPERATOR_CHARS = ['+', '-', '=', '^', '_', '(', ')', '[', ']', '!', ',', ';', ':'];

    // Tokenize LaTeX: commands (\frac, \left( ...), braced groups, operators, words.
    function tokenizeLatex(latex) {
        const tokens = [];
        let current = '';
        let braceDepth = 0;
        let i = 0;

        const flush = () => {
            if (current.trim()) tokens.push(current.trim());
            current = '';
        };

        while (i < latex.length) {
            const char = latex[i];

            if (char === '\\') {                       // command: \name + letters
                flush();
                let cmd = '\\';
                i++;
                while (i < latex.length && /[a-zA-Z]/.test(latex[i])) cmd += latex[i++];
                if (cmd === '\\left' || cmd === '\\right') {  // delimiter attached to \left/\right
                    if (i < latex.length) cmd += latex[i++];
                }
                tokens.push(cmd);
                continue;
            }

            if (char === '{') { braceDepth++; current += char; i++; continue; }

            if (char === '}') {
                braceDepth--;
                current += char;
                i++;
                if (braceDepth === 0) flush();
                continue;
            }

            if (braceDepth > 0) { current += char; i++; continue; }

            if (OPERATOR_CHARS.includes(char)) {
                flush();
                tokens.push(char);
                i++;
                continue;
            }

            if (/\s/.test(char)) { flush(); i++; continue; }

            current += char;
            i++;
        }
        flush();
        return tokens;
    }

    // Consume a braced group starting at tokens[k] ('{'), return [text, nextIndex].
    function readGroup(tokens, k) {
        let text = '';
        let depth = 0;
        for (; k < tokens.length; k++) {
            if (tokens[k] === '{') depth++;
            else if (tokens[k] === '}') depth--;
            text += tokens[k];
            if (depth === 0) { k++; break; }
        }
        return [text, k];
    }

    // Group tokens into human-sized fragments (fractions, roots, powers, subscripts, brackets).
    function groupTokensToFragments(tokens) {
        const fragments = [];

        for (let j = 0; j < tokens.length; j++) {
            const token = tokens[j];

            if (token === '\\frac') {                  // \frac{num}{den}
                let fracStr = token;
                let k = j + 1;
                let partCount = 0;
                let depth = 0;
                while (k < tokens.length && partCount < 2) {
                    const t = tokens[k];
                    if (t === '{') {
                        if (depth === 0) fracStr += '{';
                        else fracStr += t;
                        depth++;
                    } else if (t === '}') {
                        depth--;
                        if (depth === 0) { fracStr += '}'; partCount++; }
                        else fracStr += t;
                    } else {
                        fracStr += t;
                    }
                    k++;
                }
                fragments.push(fracStr);
                j = k - 1;
                continue;
            }

            if (token === '\\sqrt') {                  // \sqrt{...}
                let sqrtStr = token;
                let k = j + 1;
                if (tokens[k] === '{') {
                    const [group, next] = readGroup(tokens, k);
                    sqrtStr += group;
                    k = next;
                }
                fragments.push(sqrtStr);
                j = k - 1;
                continue;
            }

            if (token === '^' || token === '_') {      // power / subscript glued to previous fragment
                const base = fragments.pop() || '';
                let affix = token;
                let k = j + 1;
                if (tokens[k] === '{') {
                    const [group, next] = readGroup(tokens, k);
                    affix += group;
                    k = next;
                } else if (k < tokens.length) {
                    affix += tokens[k];
                    k++;
                }
                fragments.push(base + affix);
                j = k - 1;
                continue;
            }

            if (token.startsWith('\\left')) {          // \left...\right span (nesting aware)
                let bracketStr = token;
                let depth = 1;
                let k = j + 1;
                while (k < tokens.length && depth > 0) {
                    if (tokens[k].startsWith('\\left')) depth++;
                    else if (tokens[k].startsWith('\\right')) depth--;
                    bracketStr += tokens[k];
                    k++;
                }
                fragments.push(bracketStr);
                j = k - 1;
                continue;
            }

            fragments.push(token);
        }

        return fragments.filter(f => f.trim());
    }

    function parseLatexToFragments(latex) {
        return groupTokensToFragments(tokenizeLatex(latex || ''));
    }

    global.parseLatexToFragments = parseLatexToFragments;
})(typeof window !== 'undefined' ? window : globalThis);
