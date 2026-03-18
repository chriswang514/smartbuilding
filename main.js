import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jieba from 'nodejieba';
import * as mupdf from 'mupdf';
import { fileURLToPath } from 'url';

// ES Module 中取得 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= 配置區 =================
const PDF_FOLDER = path.join(__dirname, 'smartbuilding');
const OUTPUT_FOLDER = path.join(__dirname, 'docs');
const TRIAL_FOLDER = path.join(OUTPUT_FOLDER, 'trial');
const META_FOLDER = path.join(OUTPUT_FOLDER, 'meta');

const CACHE_FILE = path.join(__dirname, 'conversion_cache.json');
const TRIAL_FILE = path.join(__dirname, 'trial_links.txt');
const SECRET_KEY = process.env.SECRET_KEY || 'github.chriswang514';

const ENABLE_TRIAL_LINK = true;
const TRIAL_DAYS = 7;

const STOPWORDS = ['的','了','是','在','與','和','及','可以','我們','你','他','她',
                   'this','that','with','from','page','figure','table','pdf','http','https','www'];

// ================= 初始化 =================
if(!fs.existsSync(OUTPUT_FOLDER)) fs.mkdirSync(OUTPUT_FOLDER, {recursive:true});
if(!fs.existsSync(TRIAL_FOLDER)) fs.mkdirSync(TRIAL_FOLDER, {recursive:true});
if(!fs.existsSync(META_FOLDER)) fs.mkdirSync(META_FOLDER, {recursive:true});

let GLOBAL_WORD_FREQ = {};
let FILE_COUNT = 0;

// ================= 快取簽名機制 =================
function saveCacheWithSignature(cacheObj) {
    const dataString = JSON.stringify(cacheObj, null, 2);
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(dataString).digest('hex');
    const output = { signature: signature, data: cacheObj };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(output, null, 2));
    console.log('💾 快取已儲存並簽名');
}

function loadCacheWithVerification() {
    if (!fs.existsSync(CACHE_FILE)) {
        console.log('📝 未找到快取檔案，將建立新快取');
        return {};
    }
    try {
        const fileContent = fs.readFileSync(CACHE_FILE, 'utf8');
        const parsed = JSON.parse(fileContent);
        if (!parsed.signature) {
            console.warn('⚠️  偵測到舊快取格式（未簽名），建議重建快取');
            return parsed;
        }
        const dataString = JSON.stringify(parsed.data, null, 2);
        const expectedSignature = crypto.createHmac('sha256', SECRET_KEY).update(dataString).digest('hex');
        if (parsed.signature !== expectedSignature) {
            console.error('❌ 快取簽名驗證失敗！檔案可能被竄改，為安全起見將忽略快取。');
            return {};
        }
        console.log('✅ 快取簽名驗證通過');
        return parsed.data;
    } catch (e) {
        console.error('❌ 快取讀取失敗，將重建快取:', e.message);
        return {};
    }
}

// ================= 工具函數 =================
function getFileMD5(filePath){
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
}

function scanPDFs(dir){
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if(stat.isDirectory()){
            results = results.concat(scanPDFs(filePath));
        } else if(path.extname(file).toLowerCase() === '.pdf'){
            results.push(filePath);
        }
    });
    return results;
}

function scanHTMLFiles(dir){
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if(stat.isDirectory()){
            if(file !== 'trial' && file !== 'meta'){
                results = results.concat(scanHTMLFiles(filePath));
            }
        } else if(path.extname(file).toLowerCase() === '.html' && file !== 'index.html'){
            results.push(filePath);
        }
    });
    return results;
}

// ================= OCR 判斷與處理 =================
async function isScannedPDF(pdfPath){
    try {
        const doc = await mupdf.Document.openDocument(pdfPath, "application/pdf");
        const page = await doc.loadPage(0);
        const text = await page.toStructuredText("text").asText();
        
        // 如果第一頁文字少於 50 個字元，視為掃描版
        return text.trim().length < 50;
    } catch(e) {
        console.warn(`⚠️  無法判斷 PDF 類型: ${path.basename(pdfPath)}`);
        return false;
    }
}

function runOCR(pdfPath, outputPdf){
    const relInput = path.relative(__dirname, pdfPath).replace(/\\/g, '/');
    const relOutput = path.relative(__dirname, outputPdf).replace(/\\/g, '/');
    
    const cmd = `docker run --rm -v "${__dirname}:/data" ocrmypdf-chi -l chi_tra+eng --skip-text --output-type pdf "/data/${relInput}" "/data/${relOutput}"`;
    
    console.log(`🔄 執行 OCR: ${path.basename(pdfPath)}`);
    
    execSync(cmd, {stdio: 'ignore'});
    console.log(`✅ OCR 完成: ${path.basename(outputPdf)}`);
}

// ================= PDF → HTML (使用 MuPDF) =================
async function convertPDF(pdfPath){
    const md5 = getFileMD5(pdfPath);
    const relativePath = path.relative(PDF_FOLDER, pdfPath);
    const outputDir = path.join(OUTPUT_FOLDER, path.dirname(relativePath));
    const baseName = path.basename(pdfPath, '.pdf');
    const outputPath = path.join(outputDir, `${baseName}.html`);

    // 檢查快取
    if(cache[pdfPath] && cache[pdfPath] === md5 && fs.existsSync(outputPath)){
        console.log(`⏭️  跳過（未變更）: ${relativePath}`);
        return outputPath;
    }

    if(!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, {recursive:true});

    // OCR 判斷
    let pdfToUse = pdfPath;
    if(await isScannedPDF(pdfPath)){
        console.log(`🔍 偵測到掃描版 PDF: ${relativePath}`);
        const tempPdf = path.join(outputDir, 'ocr_' + path.basename(pdfPath));
        runOCR(pdfPath, tempPdf);
        pdfToUse = tempPdf;
    }

    // PDF → HTML (使用 MuPDF)
    console.log(`🔄 轉換中 (MuPDF): ${relativePath}`);

    try {
        const doc = await mupdf.Document.openDocument(pdfToUse, "application/pdf");
        const pageCount = doc.countPages();
        
        let html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${baseName}</title>
    <style>
        body { 
            font-family: Arial, "Microsoft JhengHei", sans-serif; 
            max-width: 1200px; 
            margin: 0 auto; 
            padding: 20px;
            background: #f5f5f5;
        }
        .page { 
            background: white;
            margin-bottom: 40px; 
            padding: 40px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            page-break-after: always;
        }
        .page-number {
            color: #666;
            font-size: 14px;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid #eee;
        }
        .text-block { 
            margin: 10px 0; 
            line-height: 1.8;
        }
        @media print {
            body { background: white; }
            .page { box-shadow: none; page-break-after: always; }
        }
    </style>
</head>
<body>
    <h1>${baseName}</h1>
`;

        for(let i = 0; i < pageCount; i++){
            const page = await doc.loadPage(i);
            const stext = await page.toStructuredText("html");
            const pageHTML = await stext.asHTML();
            
            html += `    <div class="page" id="page-${i + 1}">
        <div class="page-number">第 ${i + 1} 頁 / 共 ${pageCount} 頁</div>
        ${pageHTML}
    </div>\n`;
        }

        html += `</body>
</html>`;

        fs.writeFileSync(outputPath, html, 'utf8');
        cache[pdfPath] = md5;
        console.log(`✅ 轉換完成: ${relativePath}`);
        return outputPath;

    } catch(e){
        console.error(`❌ 轉換失敗: ${relativePath}`, e.message);
        throw e;
    }
}

// ================= Trial Link =================
function generateTrialToken(){
    return crypto.randomBytes(8).toString('hex');
}

function generateTrialLinks(htmlFiles){
    const timestamp = new Date().toISOString();
    let logContent = `\n=== 產出時間: ${timestamp} ===\n`;
    const links = [];
    
    htmlFiles.forEach(htmlPath => {
        const relPath = path.relative(OUTPUT_FOLDER, htmlPath).replace(/\\/g, '/');
        const token = generateTrialToken();
        const expireDate = new Date();
        expireDate.setDate(expireDate.getDate() + TRIAL_DAYS);
        
        const trialFileName = `link_${token}.html`;
        const trialPath = path.join(TRIAL_FOLDER, trialFileName);
        
        const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>試用連結</title>
    <script>
        const expire = new Date("${expireDate.toISOString()}");
        if(new Date() > expire){
            document.write('<h1>⚠️ 此連結已過期</h1><p>請聯繫管理員取得新連結</p>');
        } else {
            window.location.href = "/${relPath}";
        }
    </script>
</head>
<body>
    <p>正在跳轉...</p>
</body>
</html>`;
        
        fs.writeFileSync(trialPath, html, 'utf8');
        
        const trialUrl = `trial/${trialFileName}`;
        logContent += `${relPath} -> ${trialUrl} (過期: ${expireDate.toISOString()})\n`;
        
        links.push({
            original: relPath,
            trial: trialUrl,
            expire: expireDate.toISOString()
        });
    });
    
    fs.appendFileSync(TRIAL_FILE, logContent, 'utf8');
    console.log(`🔗 已生成 ${links.length} 個 Trial links`);
    
    return links;
}

// ================= 文字處理 =================
function htmlToText(html){
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
}

function cleanText(text){
    return text
        .replace(/[0-9]/g, ' ')
        .replace(/[^\u4e00-\u9fa5a-zA-Z]/g, ' ')
        .replace(/\s+/g, ' ');
}

function tokenize(text){
    const wordsCn = jieba.cut(text);
    const wordsEn = text.toLowerCase().split(/\s+/);
    return wordsCn.concat(wordsEn);
}

// ================= TF-IDF =================
function buildGlobalFreq(htmlFiles){
    FILE_COUNT = htmlFiles.length;
    GLOBAL_WORD_FREQ = {};
    
    console.log('📊 建立全域詞頻表...');
    
    htmlFiles.forEach(htmlPath => {
        if(!fs.existsSync(htmlPath)) return;
        
        const html = fs.readFileSync(htmlPath, 'utf8');
        const text = cleanText(htmlToText(html));
        const words = new Set(tokenize(text));
        
        words.forEach(w => {
            if(!w || STOPWORDS.includes(w) || w.length < 2) return;
            if(!GLOBAL_WORD_FREQ[w]) GLOBAL_WORD_FREQ[w] = 0;
            GLOBAL_WORD_FREQ[w]++;
        });
    });
    
    console.log(`✅ 全域詞頻建立完成 (共 ${Object.keys(GLOBAL_WORD_FREQ).length} 個詞)`);
}

function extractKeywordsTFIDF(text, topN = 15){
    const words = tokenize(text);
    let tf = {};
    
    words.forEach(w => {
        if(!w || STOPWORDS.includes(w) || w.length < 2) return;
        if(!tf[w]) tf[w] = 0;
        tf[w]++;
    });
    
    let scores = [];
    Object.keys(tf).forEach(w => {
        const tfv = tf[w];
        const df = GLOBAL_WORD_FREQ[w] || 1;
        const idf = Math.log(FILE_COUNT / df);
        scores.push([w, tfv * idf]);
    });
    
    scores.sort((a, b) => b[1] - a[1]);
    return scores.slice(0, topN).map(x => x[0]);
}

function splitChunks(text, size = 500){
    let chunks = [];
    for(let i = 0; i < text.length; i += size){
        chunks.push(text.substring(i, i + size));
    }
    return chunks;
}

function buildMetaAndChunks(htmlFiles){
    console.log('📄 生成 Meta 資料和 Chunks...');
    
    const allLinks = [];
    const keywordsList = [];
    const ocrIndex = [];
    const chunksList = [];
    
    htmlFiles.forEach(htmlPath => {
        if(!fs.existsSync(htmlPath)) return;
        
        const relPath = path.relative(OUTPUT_FOLDER, htmlPath).replace(/\\/g, '/');
        allLinks.push(relPath);
        
        const html = fs.readFileSync(htmlPath, 'utf8');
        const text = cleanText(htmlToText(html));
        
        const keywords = extractKeywordsTFIDF(text);
        const preview = text.substring(0, 200);
        
        keywordsList.push({
            file: relPath,
            keywords: keywords
        });
        
        ocrIndex.push({
            file: relPath,
            keywords: keywords,
            preview: preview
        });
        
        const chunks = splitChunks(text, 500);
        chunks.forEach((chunk, i) => {
            const chunkKeywords = extractKeywordsTFIDF(chunk, 10);
            chunksList.push({
                file: relPath,
                chunk: i + 1,
                text: chunk,
                keywords: chunkKeywords
            });
        });
    });
    
    fs.writeFileSync(path.join(META_FOLDER, 'all_links.json'), JSON.stringify(allLinks, null, 2));
    fs.writeFileSync(path.join(META_FOLDER, 'keywords.json'), JSON.stringify(keywordsList, null, 2));
    fs.writeFileSync(path.join(META_FOLDER, 'ocr_index.json'), JSON.stringify(ocrIndex, null, 2));
    fs.writeFileSync(path.join(META_FOLDER, 'chunks.json'), JSON.stringify(chunksList, null, 2));
    
    console.log('✅ Meta 資料已生成');
}

// ================= Index 生成 =================
function generateMainIndex(pdfFiles){
    let html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>📚 PDF 知識庫</title>
    <style>
        body { font-family: Arial, "Microsoft JhengHei", sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
        h1 { color: #333; }
        ul { list-style-type: none; padding: 0; }
        li { margin: 10px 0; }
        a { color: #0066cc; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <h1>📚 PDF 知識庫</h1>
    <ul>
`;
    
    pdfFiles.forEach(pdf => {
        const relPath = path.relative(PDF_FOLDER, pdf).replace(/\\/g, '/');
        const htmlPath = relPath.replace(/\.pdf$/i, '.html');
        const displayName = relPath.replace(/\.pdf$/i, '');
        
        html += `        <li><a href="${htmlPath}">${displayName}</a></li>\n`;
    });
    
    html += `    </ul>
</body>
</html>`;
    
    fs.writeFileSync(path.join(OUTPUT_FOLDER, 'index.html'), html, 'utf8');
    console.log('📄 主索引已生成');
}

function generateSubIndex(dir){
    const files = fs.readdirSync(dir);
    const htmlFiles = files.filter(f => {
        const fullPath = path.join(dir, f);
        return fs.statSync(fullPath).isFile() && f.toLowerCase().endsWith('.html') && f !== 'index.html';
    });
    const subdirs = files.filter(f => {
        const fullPath = path.join(dir, f);
        return fs.statSync(fullPath).isDirectory() && f !== 'trial' && f !== 'meta';
    });
    
    if(htmlFiles.length > 0){
        let html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>📂 ${path.basename(dir)}</title>
    <style>
        body { font-family: Arial, "Microsoft JhengHei", sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
        h1 { color: #333; }
        ul { list-style-type: none; padding: 0; }
        li { margin: 10px 0; }
        a { color: #0066cc; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <h1>📂 ${path.basename(dir)}</h1>
    <ul>
`;
        
        htmlFiles.forEach(f => {
            html += `        <li><a href="${f}">${f.replace('.html', '')}</a></li>\n`;
        });
        
        html += `    </ul>
</body>
</html>`;
        
        fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
        console.log(`📄 子目錄索引已生成: ${path.relative(OUTPUT_FOLDER, dir)}`);
    }
    
    subdirs.forEach(subdir => {
        generateSubIndex(path.join(dir, subdir));
    });
}

// ================= README 生成 =================
function generateReadme(trialLinks){
    console.log('📝 生成 README...');
    
    function traverse(dir, level = 0){
        let md = '';
        const files = fs.readdirSync(dir);
        const htmlFiles = files.filter(f => {
            const fullPath = path.join(dir, f);
            return fs.statSync(fullPath).isFile() && f.toLowerCase().endsWith('.html') && f !== 'index.html';
        });
        const subdirs = files.filter(f => {
            const fullPath = path.join(dir, f);
            return fs.statSync(fullPath).isDirectory() && f !== 'trial' && f !== 'meta';
        });
        
        if(htmlFiles.length > 0){
            md += `${'#'.repeat(level + 2)} ${path.relative(OUTPUT_FOLDER, dir) || '根目錄'}\n\n`;
            
            htmlFiles.forEach(f => {
                const htmlPath = path.join(dir, f);
                const relPath = path.relative(OUTPUT_FOLDER, htmlPath).replace(/\\/g, '/');
                
                const trialInfo = trialLinks.find(t => t.original === relPath);
                
                md += `- **${f}**\n`;
                md += `  - 永久連結: [${relPath}](${relPath})\n`;
                if(trialInfo){
                    const expireDate = new Date(trialInfo.expire);
                    const isValid = new Date() < expireDate;
                    md += `  - Trial link: [${trialInfo.trial}](${trialInfo.trial}) ${isValid ? '✅ (有效)' : '❌ (已過期)'}\n`;
                }
            });
            md += '\n';
        }
        
        subdirs.forEach(subdir => {
            md += traverse(path.join(dir, subdir), level + 1);
        });
        
        return md;
    }
    
    const mdContent = `# 📚 PDF 知識庫連結列表

> 永久連結與 Trial link（過期會標示）
> 
> 🔒 本系統使用 HMAC-SHA256 簽名保護快取檔案
> 🔧 使用 MuPDF 進行 PDF 轉換（支援所有現代 PDF 格式）

## 系統資訊

- **快取檔案**: \`conversion_cache.json\` (已簽名)
- **Trial 記錄**: \`trial_links.txt\`
- **Meta 資料**: \`site/meta/\`

` + traverse(OUTPUT_FOLDER);
    
    fs.writeFileSync(path.join(OUTPUT_FOLDER, 'README_links.md'), mdContent, 'utf8');
    console.log('✅ README_links.md 已生成');
}

// ================= 主程式 =================
let cache = {};

async function main(){
    console.log('🚀 PDF 知識庫系統啟動 (使用 MuPDF 引擎)\n');
    console.log('='.repeat(50));
    
    cache = loadCacheWithVerification();
    
    console.log('🔍 掃描 PDF 檔案...');
    const pdfFiles = scanPDFs(PDF_FOLDER);
    
    if(pdfFiles.length === 0){
        console.log('⚠️  未找到任何 PDF 檔案');
        return;
    }
    
    console.log(`📂 找到 ${pdfFiles.length} 個 PDF 檔案\n`);
    console.log('='.repeat(50));
    
    for(const pdf of pdfFiles){
        await convertPDF(pdf);
    }
    
    console.log('\n' + '='.repeat(50));
    
    saveCacheWithSignature(cache);
    
    generateMainIndex(pdfFiles);
    generateSubIndex(OUTPUT_FOLDER);
    
    const htmlFiles = scanHTMLFiles(OUTPUT_FOLDER);
    console.log(`📄 找到 ${htmlFiles.length} 個 HTML 檔案`);
    
    buildGlobalFreq(htmlFiles);
    buildMetaAndChunks(htmlFiles);
    
    let trialLinks = [];
    if(ENABLE_TRIAL_LINK){
        trialLinks = generateTrialLinks(htmlFiles);
    }
    
    generateReadme(trialLinks);
    
    console.log('\n' + '='.repeat(50));
    console.log('🎉 所有轉換完成！');
    console.log('='.repeat(50));
    console.log('\n📊 輸出摘要:');
    console.log(`   - HTML 檔案: ${htmlFiles.length} 個`);
    console.log(`   - Trial links: ${trialLinks.length} 個`);
    console.log(`   - Meta 資料: site/meta/`);
    console.log(`   - 主索引: site/index.html`);
    console.log(`   - README: site/README_links.md`);
}

main().catch(error => {
    console.error('\n❌ 程式執行失敗:', error);
    process.exit(1);
});
