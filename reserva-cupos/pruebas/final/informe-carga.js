function escapar(texto) {
    return String(texto).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function leerResumen(texto) {
    const linea = texto.split(/\r?\n/).find(l => l.startsWith('PDC_K6_JSON:'));
    if (!linea) throw new Error('k6 no produjo el resumen estructurado esperado');
    return JSON.parse(linea.slice('PDC_K6_JSON:'.length));
}
function htmlResumen(titulo, resumen, graficos = '') {
    const filas = Object.entries(resumen.metricas || {}).map(([nombre, dato]) => `<tr><td>${escapar(nombre)}</td><td><pre>${escapar(JSON.stringify(dato.values, null, 2))}</pre></td></tr>`).join('');
    return `<!doctype html><html lang="es"><meta charset="utf-8"><title>${escapar(titulo)}</title>
<style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#172033}table{border-collapse:collapse;width:100%}td,th{padding:8px;border:1px solid #ddd;text-align:left}pre{white-space:pre-wrap}svg{width:100%;border:1px solid #ddd}h1{font-size:28px}</style>
<h1>${escapar(titulo)}</h1><p>Generado con los resultados reales de k6. Las tasas generales de k6 incluyen setup y teardown; usar los histogramas de admision para su latencia.</p>
${graficos}<table><thead><tr><th>Metrica</th><th>Valores</th></tr></thead><tbody>${filas}</tbody></table></html>`;
}
module.exports = { leerResumen, htmlResumen, escapar };
