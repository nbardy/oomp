/**
 * Parser utilities for Claude stream-json output
 * Ported from the Python parser - handles tool calls and text formatting
 */

class StreamParser {
  // Solarized color palette (CSS classes will handle actual colors)
  static COLORS = {
    BLUE: 'color-blue', // Tool names
    CYAN: 'color-cyan', // Parameter keys
    GREEN: 'color-green', // Emphasis
    YELLOW: 'color-yellow', // Values
    ORANGE: 'color-orange', // Tool icons
    BASE1: 'color-base1', // Dim text
    DIM: 'dim',
  };

  // Tool-specific emojis
  static EMOJI = {
    Read: '📖',
    Edit: '✏️',
    Write: '📝',
    Bash: '💻',
    Glob: '🔍',
    Grep: '🔎',
    TodoWrite: '📋',
    Task: '🤖',
    LSP: '🔗',
    WebFetch: '🌐',
    WebSearch: '🔍',
  };

  static truncate(s, maxLen = 40) {
    if (!s) return '';
    if (s.length <= maxLen) return s;
    return `${s.substring(0, maxLen - 3)}...`;
  }

  static countLines(s) {
    if (!s) return 0;
    return s.split('\n').length;
  }

  static getEmoji(toolName) {
    return StreamParser.EMOJI[toolName] || '🔧';
  }

  static formatTool(name, inputs) {
    if (!inputs) inputs = {};

    const emoji = StreamParser.getEmoji(name);

    // File-based tools
    if (name === 'Read') {
      const filePath = inputs.file_path || '';
      const filename = filePath.split('/').pop();
      return {
        html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">Read</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.escapeHtml(filename)}</span></span>`,
        text: `${emoji} Read ${filename}`,
      };
    }

    if (name === 'Edit') {
      const filePath = inputs.file_path || '';
      const filename = filePath.split('/').pop();
      const oldStr = inputs.old_string || '';
      const newStr = inputs.new_string || '';
      const oldLines = StreamParser.countLines(oldStr);
      const newLines = StreamParser.countLines(newStr);
      const diff = newLines - oldLines;
      const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
      return {
        html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">Edit</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.escapeHtml(filename)}</span> <span class="${StreamParser.COLORS.DIM}}">(${diffStr} lines)</span></span>`,
        text: `${emoji} Edit ${filename} (${diffStr} lines)`,
      };
    }

    if (name === 'Write') {
      const filePath = inputs.file_path || '';
      const filename = filePath.split('/').pop();
      const content = inputs.content || '';
      const lines = StreamParser.countLines(content);
      return {
        html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">Write</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.escapeHtml(filename)}</span> <span class="${StreamParser.COLORS.DIM}}">(${lines} lines)</span></span>`,
        text: `${emoji} Write ${filename} (${lines} lines)`,
      };
    }

    // Bash
    if (name === 'Bash') {
      const cmd = inputs.command || '';
      const desc = inputs.description || '';
      const cmdShort = StreamParser.truncate(cmd, 50);
      const descShort = StreamParser.truncate(desc, 30);

      if (desc) {
        return {
          html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">Bash</span>: <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.escapeHtml(cmdShort)}</span> <span class="${StreamParser.COLORS.DIM}}">(${StreamParser.escapeHtml(descShort)})</span></span>`,
          text: `${emoji} Bash: ${cmdShort} (${descShort})`,
        };
      }
      return {
        html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">Bash</span>: <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.escapeHtml(cmdShort)}</span></span>`,
        text: `${emoji} Bash: ${cmdShort}`,
      };
    }

    // Glob
    if (name === 'Glob') {
      const pattern = inputs.pattern || '';
      const path = inputs.path || '';
      if (path) {
        return {
          html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">Glob</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.escapeHtml(pattern)}</span> <span class="${StreamParser.COLORS.DIM}">in ${StreamParser.truncate(path, 30)}</span></span>`,
          text: `${emoji} Glob ${pattern} in ${StreamParser.truncate(path, 30)}`,
        };
      }
      return {
        html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">Glob</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.escapeHtml(pattern)}</span></span>`,
        text: `${emoji} Glob ${pattern}`,
      };
    }

    // Grep
    if (name === 'Grep') {
      const pattern = inputs.pattern || '';
      const path = inputs.path || '';
      if (path) {
        return {
          html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">Grep</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.truncate(pattern, 40)}</span> <span class="${StreamParser.COLORS.DIM}">in ${StreamParser.truncate(path, 30)}</span></span>`,
          text: `${emoji} Grep ${StreamParser.truncate(pattern, 40)} in ${StreamParser.truncate(path, 30)}`,
        };
      }
      return {
        html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">Grep</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.truncate(pattern, 40)}</span></span>`,
        text: `${emoji} Grep ${StreamParser.truncate(pattern, 40)}`,
      };
    }

    // LSP
    if (name === 'LSP') {
      const op = inputs.operation || '';
      const filePath = inputs.filePath || '';
      const filename = filePath.split('/').pop();
      const line = inputs.line || '';
      return {
        html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">LSP</span> <span class="${StreamParser.COLORS.CYAN}">${StreamParser.escapeHtml(op)}</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.escapeHtml(filename)}:${line}</span></span>`,
        text: `${emoji} LSP ${op} ${filename}:${line}`,
      };
    }

    // WebFetch
    if (name === 'WebFetch') {
      const url = inputs.url || '';
      return {
        html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">WebFetch</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.truncate(url, 60)}</span></span>`,
        text: `${emoji} WebFetch ${StreamParser.truncate(url, 60)}`,
      };
    }

    // WebSearch
    if (name === 'WebSearch') {
      const query = inputs.query || '';
      return {
        html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">WebSearch</span> <span class="${StreamParser.COLORS.YELLOW}">${StreamParser.truncate(query, 50)}</span></span>`,
        text: `${emoji} WebSearch ${StreamParser.truncate(query, 50)}`,
      };
    }

    // Fallback
    return {
      html: `<span class="tool-call"><span class="emoji">${emoji}</span> <span class="${StreamParser.COLORS.BLUE}">${name}</span></span>`,
      text: `${emoji} ${name}`,
    };
  }

  static escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  static formatMessage(message, role) {
    if (role === 'user') {
      return `<div class="message-user"><span class="role">User:</span> ${StreamParser.escapeHtml(message)}</div>`;
    }
    return `<div class="message-assistant"><span class="role">Assistant:</span> ${StreamParser.escapeHtml(message)}</div>`;
  }
}
