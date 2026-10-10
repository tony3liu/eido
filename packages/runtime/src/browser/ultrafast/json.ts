// Python json.dumps compatibility for the upstream wire format and fingerprints.
// CDP returnByValue JSON has already normalized integral floats to integers.
const string = (value: string) => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
  character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
export function pythonJson(value: unknown, sortKeys = false): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return string(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite JSON number');
    // Python uses exponent notation below 1e-4, with a two-digit exponent.
    const number = value !== 0 && (Math.abs(value) < 1e-4 || Math.abs(value)>=1e16) && !Number.isInteger(value) ? value.toExponential()
      : value !== 0 && Math.abs(value)<1e-4 ? value.toExponential() : String(value);
    return number.replace(/e([+-]?)(\d+)$/, (_, sign, digits) => `e${sign || '+'}${digits.padStart(2, '0')}`);
  }
  if (Array.isArray(value)) return '[' + value.map(item => pythonJson(item, sortKeys)).join(', ') + ']';
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (sortKeys) keys.sort((a, b) => {
      const left = [...a].map(c => c.codePointAt(0)!), right = [...b].map(c => c.codePointAt(0)!);
      for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
      return left.length - right.length;
    });
    return '{' + keys.map(key => string(key) + ': ' + pythonJson(object[key], sortKeys)).join(', ') + '}';
  }
  throw new Error('Unsupported JSON value');
}
