// apps/browse/src/components/CodeBlock.tsx
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface CodeBlockProps {
  code: string;
  language?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
}

export function CodeBlock({ code, language = 'typescript', filePath, lineStart, lineEnd }: CodeBlockProps) {
  return (
    <div className="rounded-lg overflow-hidden bg-[#1e1e2e]">
      {/* Header */}
      {(filePath || language) && (
        <div className="flex items-center justify-between px-4 py-2 bg-[#2d2d3d] border-b border-gray-700">
          {filePath && (
            <span className="text-sm text-gray-400 font-mono">
              {filePath}
              {lineStart && `#L${lineStart}${lineEnd ? `-L${lineEnd}` : ''}`}
            </span>
          )}
          {language && (
            <span className="text-xs text-gray-500 uppercase">{language}</span>
          )}
        </div>
      )}

      {/* Code */}
      <div className="p-4 overflow-auto">
        <SyntaxHighlighter
          language={language}
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: 0,
            background: 'transparent',
            fontSize: '14px',
            lineHeight: '1.6'
          }}
          showLineNumbers={true}
          startingLineNumber={lineStart || 1}
          wrapLines={true}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
