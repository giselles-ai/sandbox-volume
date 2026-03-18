import type { ReactNode } from 'react'
import readme from '../../README.md?raw'
import './App.css'

type Block =
  | { type: 'heading'; level: 1 | 2; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; language: string; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }

function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim()
      const content: string[] = []
      index += 1

      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        content.push(lines[index])
        index += 1
      }

      if (index < lines.length) {
        index += 1
      }

      blocks.push({ type: 'code', language, content: content.join('\n') })
      continue
    }

    const h1Match = trimmed.match(/^# (.+)$/)
    if (h1Match) {
      blocks.push({ type: 'heading', level: 1, text: h1Match[1] })
      index += 1
      continue
    }

    const h2Match = trimmed.match(/^## (.+)$/)
    if (h2Match) {
      blocks.push({ type: 'heading', level: 2, text: h2Match[1] })
      index += 1
      continue
    }

    const orderedMatch = trimmed.match(/^\d+\. /)
    const unorderedMatch = trimmed.startsWith('- ')
    if (orderedMatch || unorderedMatch) {
      const ordered = Boolean(orderedMatch)
      const items: string[] = []

      while (index < lines.length) {
        const candidate = lines[index].trim()
        const matches = ordered ? /^\d+\. /.test(candidate) : candidate.startsWith('- ')
        if (!matches) {
          break
        }

        items.push(candidate.replace(ordered ? /^\d+\. / : /^- /, '').trim())
        index += 1
      }

      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paragraph: string[] = [trimmed]
    index += 1

    while (index < lines.length) {
      const candidate = lines[index].trim()
      if (
        !candidate ||
        candidate.startsWith('#') ||
        candidate.startsWith('```') ||
        /^\d+\. /.test(candidate) ||
        candidate.startsWith('- ')
      ) {
        break
      }

      paragraph.push(candidate)
      index += 1
    }

    blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
  }

  return blocks
}

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean)

  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>
    }

    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>
    }

    return <span key={index}>{part}</span>
  })
}

const blocks = parseMarkdown(readme)

function App() {
  const titleBlock = blocks.find((block) => block.type === 'heading' && block.level === 1)
  const leadBlock = blocks.find((block) => block.type === 'paragraph')
  const title = titleBlock?.type === 'heading' ? titleBlock.text : 'README'
  const lead = leadBlock?.type === 'paragraph' ? leadBlock.text : ''

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Package overview</p>
        <h1>{title}</h1>
        {lead ? <p className="lead">{renderInline(lead)}</p> : null}
      </section>

      <article className="readme-card">
        {blocks.map((block, index) => {
          if (index <= 1) {
            return null
          }

          switch (block.type) {
            case 'heading':
              return block.level === 2 ? (
                <h2 key={index}>{block.text}</h2>
              ) : (
                <h1 key={index}>{block.text}</h1>
              )

            case 'paragraph':
              return <p key={index}>{renderInline(block.text)}</p>

            case 'code':
              return (
                <pre key={index} className="code-block">
                  <code>{block.content}</code>
                </pre>
              )

            case 'list': {
              const ListTag = block.ordered ? 'ol' : 'ul'

              return (
                <ListTag key={index}>
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{renderInline(item)}</li>
                  ))}
                </ListTag>
              )
            }
          }
        })}
      </article>
    </main>
  )
}

export default App
