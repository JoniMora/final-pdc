// Solo staging explicito de un grupo. Nunca commit, push ni cambio de rama.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const raiz = path.resolve(__dirname, '../..');
const grupos = JSON.parse(fs.readFileSync(path.join(raiz, 'docs/entrega-6/commits.json'), 'utf8'));
const argumento = process.argv[2];
if (argumento === '--listar' || argumento === undefined) {
    grupos.forEach((g, i) => console.log(`${i}: ${g.titulo} (${g.archivos.length} rutas)`));
} else {
    try {
        if (!/^\d+$/.test(argumento) || !grupos[Number(argumento)]) throw new Error('Grupo invalido; usar --listar');
        const git = args => execFileSync('git', args, { cwd: raiz, encoding: 'utf8' }).trim();
        if (git(['branch', '--show-current']) !== 'entrega-6-final') throw new Error('Usar la rama entrega-6-final; no se cambia automaticamente');
        if (git(['diff', '--cached', '--name-only'])) throw new Error('Ya hay archivos preparados; revisarlos antes de agregar otro grupo');
        const grupo = grupos[Number(argumento)];
        for (const archivo of grupo.archivos) {
            const absoluto = path.resolve(raiz, archivo);
            if (!absoluto.startsWith(raiz + path.sep) || !fs.existsSync(absoluto)) throw new Error(`Ruta invalida o faltante: ${archivo}`);
        }
        git(['add', '--', ...grupo.archivos]);
        git(['diff', '--cached', '--check']);
        const cambios = git(['diff', '--cached', '--stat']);
        if (!cambios) throw new Error('Este grupo ya estaba confirmado o no tiene cambios');
        console.log(cambios);
        console.log('\nRevisar con: git --no-pager diff --cached');
        console.log(`git commit -m "${grupo.titulo}"`);
        console.log('git push origin entrega-6-final');
    } catch (e) { console.error(e.message); process.exitCode = 1; }
}
