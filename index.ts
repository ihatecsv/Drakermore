import { serve } from 'bun';
import JSZip from 'jszip';
import { promises as fs } from 'fs';
import crypto from 'crypto';

const port = 3000;
const publicHost = `http://localhost:${port}`

async function loadPackJson(packId: string) {
    const packPath = `./packs/${packId}/pack.json`;
    const packData = await fs.readFile(packPath, 'utf-8');
    return JSON.parse(packData);
}

async function getModJars(packId: string) {
    return fs.readdir(`./packs/${packId}/mods`);
}

async function hashFile(filename: string) {
    const hash = crypto.createHash('sha512');
    const data = await fs.readFile(filename);
    hash.update(data);
    return hash.digest('hex');
}

function generateInstanceConfig(modpackID: string, modpack: any): string {
    return `InstanceType=OneSix
OverrideCommands=true
PreLaunchCommand="$INST_JAVA" -jar packwiz-installer-bootstrap.jar ${publicHost}/packs/${modpackID}/packwiz/pack.toml
name=${modpack.name}
`.trim();
}

async function generatePackTOML(pack: any, indexHash: string): Promise<string> {
    return `name = "${pack.name}"
pack-format = "${pack.packTomlFormat}"

[versions]
minecraft = "${pack.minecraftVersion}"
fabric = "${pack.fabricLoaderVersion}"

[index]
file = "index.toml"
hash-format = "sha512"
hash = "${indexHash}"
`;
}

async function generateIndexTOML(modpackID: string, modJars: string[]): Promise<string> {
    const modEntries = await Promise.all(modJars.map(async jar => {
        const modTOMLContent = await generateModTOML(modpackID, jar);
        const hash = crypto.createHash('sha512').update(modTOMLContent).digest('hex');
        return `
[[files]]
file = "mods/${jar}.pw.toml"
hash = "${hash}"
metafile = true
`;
    }));
    return `hash-format = "sha512"
${modEntries.join('')}
`.trim();
}

async function generateModTOML(modpackID: string, modFilename: string): Promise<string> {
    const modPath = `./packs/${modpackID}/mods/${modFilename}`;
    const hash = await hashFile(modPath);
    return `name="${modFilename.replace(".jar", "")}"
filename="${modFilename}"

[download]
url = "${publicHost}/packs/${modpackID}/mods/${modFilename}"
hash-format = "sha512"
hash = "${hash}"
`.trim();
}

serve({
    async fetch(req) {
        const url = new URL(req.url);
        const modpackID = url.pathname.split('/')[2];

        const modpack = await loadPackJson(modpackID);
        const modJars = await getModJars(modpackID);

        if (!modpack) {
            return new Response("Modpack not found!", { status: 404 });
        }

        if (url.pathname.startsWith('/packs/') && url.pathname.endsWith('.jar')) {
            const parts = url.pathname.split('/');
            const modpackId = parts[2];
            const modJarName = parts[4];

            try {
                const modJarContent = await fs.readFile(`./packs/${modpackId}/mods/${modJarName}`);
                return new Response(modJarContent, {
                    headers: {
                        'Content-Type': 'application/java-archive',
                        'Content-Disposition': `attachment; filename=${modJarName}`
                    }
                });
            } catch (error) {
                return new Response("Mod jar not found!", { status: 404 });
            }
        } else if (url.pathname.endsWith('/pack')) {
            const zip = new JSZip();

            zip.file("mmc-pack.json", JSON.stringify(modpack.mmcPack));

            zip.file("instance.cfg", generateInstanceConfig(modpackID, modpack));

            const jarFile = Bun.file("packwiz-installer-bootstrap.jar");
            const jarBuffer = await jarFile.arrayBuffer();
            zip.file(".minecraft/packwiz-installer-bootstrap.jar", jarBuffer);

            const content = await zip.generateAsync({ type: "nodebuffer" });

            return new Response(content, {
                headers: {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename=${modpack.name.replace(" ", "_")}.zip`
                }
            });
        } else if (url.pathname.endsWith('/packwiz/pack.toml')) {
            const indexTOML = await generateIndexTOML(modpackID, modJars);
            const indexHash = crypto.createHash('sha512').update(indexTOML).digest('hex');
            return new Response(await generatePackTOML(modpack, indexHash), { headers: { 'Content-Type': 'application/toml' } });
        } else if (url.pathname.endsWith('/packwiz/index.toml')) {
            return new Response(await generateIndexTOML(modpackID, modJars), { headers: { 'Content-Type': 'application/toml' } });
        } else if (url.pathname.endsWith('.pw.toml')) {
            const parts = url.pathname.split('/');
            const modFilename = parts[parts.length - 1].replace('.pw.toml', '');
            if (modJars.includes(modFilename)) {
                return new Response(await generateModTOML(modpackID, modFilename), { headers: { 'Content-Type': 'application/toml' } });
            } else {
                return new Response("Mod TOML not found!", { status: 404 });
            }
        } else {
            return new Response("Bad request", { status: 400 });
        }
    },
    port
});
