const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jieba = require('nodejieba');

// ================= 配置區 =================
const PDF_FOLDER = path.join(__dirname, 'smartbuilding');
const OUTPUT_FOLDER = path.join(__dirname, 'site');
const TRIAL_FOLDER = path.join(OUTPUT_FOLDER, 'trial');
const META_FOLDER = path.join(OUTPUT_FOLDER, 'meta');

const CACHE_FILE = path.join(__dirname, 'conversion_cache.json');
const TRIAL_FILE = path.join(__dirname, 'trial_links.txt');

const SECRET_KEY = 'your_super_secret_key_change_this'; // ⚠️ 請務必修改此密鑰
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

/**
 * 儲存快取並加上 HMAC 簽名
 * @param {Object} cacheObj - 快取物件
 */
function saveCacheWithSignature(cacheObj) {
    const dataString = JSON.stringify(cacheObj, null, 2);
    
    // 計算 HMAC-SHA256 簽名
    const signature = crypto
        .createHmac('sha256', SECRET_KEY)
        .update(dataString)
        .digest('hex');
    
    const output = {
        signature: signature,
        data: cacheObj
    };
    
    fs.writeFileSync(CACHE_FILE, JSON.stringify(output, null, 2));
    console.log('💾 快取已儲存並簽名');
}

/**
 * 讀取快取並驗證簽名
 * @returns {Object} 快取物件，若驗證失敗則回傳空物件
 */
function loadCacheWithVerification() {
    if (!fs.existsSync(CACHE_FILE)) {
        console.log('📝 未找到快取檔案，將建立新快取');
        return {};
    }
    
    try {
        const fileContent = fs.readFileSync(CACHE_FILE, 'utf8');
        const parsed = JSON.parse(fileContent);
        
        // 相容舊格式（無簽名）
        if (!parsed.signature) {
            console.warn('⚠️  偵測到舊快取格式（未簽名），建議重建快取');
            return parsed;
        }
        
        // 驗證簽名
        const dataString = JSON.stringify(parsed.data, null, 2);
        const expectedSignature = crypto
            .createHmac('sha256', SECRET_KEY)
            .update(dataString)
            .digest('hex');
            
        if (parsed.signature !== expectedSignature) {
            console.error('❌ 快取簽名驗證失敗！檔案可能被竄改，為安全起見將忽略快取。');
            console.error('   提示：如果你修改了 SECRET_KEY，這是正常現象。');
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

/**
 * 計算檔案的 MD5 雜湊值
 * @param {string} filePath - 檔案路徑
 * @returns {string} MD5 雜湊值
 */
function getFileMD5(filePath){
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
}

/**
 * 遞迴掃描資料夾中的所有 PDF 檔案
 * @param {string} dir - 資料夾路徑
 * @returns {Array} PDF 檔案路徑陣列
 */
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

/**
 * 遞迴掃描資料夾中的所有 HTML 檔案（排除 trial 和 meta）
 * @param {string} dir - 資料夾路徑
 * @returns {Array} HTML 檔案路徑陣列
 */
function scanHTMLFiles(dir){
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if(stat.isDirectory()){
            // 排除 trial 和 meta 資料夾
            if(file !== 'trial' && file !== 'meta'){
                results = results.concat(scanHTMLFiles(filePath));
            }
        } else if(path.extname(file).toLowerCase() === '.html' && file !== 'index.html'){
            results.push(filePath);
        }
    });
    return results;
}

// ================= OCR 判斷 =================

/**
 * 判斷 PDF 是否為掃描版（無文字層）
 * @param {string} pdfPath - PDF 檔案路徑
 * @returns {Promise<boolean>} 是否為掃描版
 */
function isScannedPDF(pdfPath){
    return new Promise((resolve) => {
        const rel = path.relative(__dirname, pdfPath).replace(/\\/g, '/');
        
        // 先測試 OCRmyPDF 是否可用
        exec(`docker run --rm jbarlow83/ocrmypdf --version`, (err) => {
            if(err) {
                console.warn('⚠️  OCRmyPDF 不可用，跳過 OCR 判斷');
                return resolve(false);
            }
            
            // 使用 OCRmyPDF 的 --skip-text 選項測試
            const testCmd = `docker run --rm -v "${__dirname}:/data" jbarlow83/ocrmypdf --skip-text "/data/${rel}" "/dev/null"`;
            
            exec(testCmd, (err, stdout, stderr) => {
                // 如果錯誤訊息包含 "already has text"，表示不是掃描版
                const hasText = stderr.includes('already has text') || stderr.includes('page already has text');
                resolve(!hasText);
            });
        });
    });
}

/**
 * 執行 OCR 處理
 * @param {string} pdfPath - 輸入 PDF 路徑
 * @param {string} outputPdf - 輸出 PDF 路徑
 * @returns {Promise<void>}
 */
function runOCR(pdfPath, outputPdf){
    return new Promise((resolve, reject) => {
        const relInput = path.relative(__dirname, pdfPath).replace(/\\/g, '/');
        const relOutput = path.relative(__dirname, outputPdf).replace(/\\/g, '/');
        
        // 使用繁體中文 + 英文 OCR
        const cmd = `docker run --rm -v "${__dirname}:/data" jbarlow83/ocrmypdf -l chi_tra+eng "/data/${relInput}" "/data/${relOutput}"`;
        
        console.log(`🔄 執行 OCR: ${path.basename(pdfPath)}`);
        
        exec(cmd, {maxBuffer: 200*1024*1024}, (err, stdout, stderr) => {
            if(err) {
                console.error(`❌ OCR 失敗: ${err.message}`);
                return reject(err);
            }
            console.log(`✅ OCR 完成: ${path.basename(outputPdf)}`);
            resolve();
        });
    });
}

// ================= PDF → HTML =================

/**
 * 將 PDF 轉換為 HTML
 * @param {string} pdfPath - PDF 檔案路徑
 * @returns {Promise<string>} 輸出的 HTML 路徑
 */
function convertPDF(pdfPath){
    return new Promise(async (resolve, reject) => {
        try {
            const md5 = getFileMD5(pdfPath);
            const relativePath = path.relative(PDF_FOLDER, pdfPath);
            const outputDir = path.join(OUTPUT_FOLDER, path.dirname(relativePath));
            const baseName = path.basename(pdfPath, '.pdf');
            const outputPath = path.join(outputDir, `${baseName}.html`);

            // 檢查快取
            if(cache[pdfPath] && cache[pdfPath] === md5 && fs.existsSync(outputPath)){
                console.log(`⏭️  跳過（未變更）: ${relativePath}`);
                return resolve(outputPath);
            }

            if(!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, {recursive:true});

            // OCR 判斷
            let pdfToUse = pdfPath;
            if(await isScannedPDF(pdfPath)){
                console.log(`🔍 偵測到掃描版 PDF: ${relativePath}`);
                const tempPdf = path.join(outputDir, 'ocr_' + path.basename(pdfPath));
                await runOCR(pdfPath, tempPdf);
                pdfToUse = tempPdf;
            }

            // PDF → HTML
            const relPdf = path.relative(__dirname, pdfToUse).replace(/\\/g, '/');
            const relHtml = path.relative(__dirname, outputPath).replace(/\\/g, '/');
            
            const cmd = `docker run --rm -v "${__dirname}:/data" pdf2htmlex-new pdf2htmlEX --zoom 1.3 "/data/${relPdf}" "/data/${relHtml}"`;

            console.log(`🔄 轉換中: ${relativePath}`);

            exec(cmd, {maxBuffer: 200*1024*1024}, (error) => {
                if(error){
                    console.error(`❌ 轉換失敗: ${relativePath}`);
                    return reject(error);
                }

                cache[pdfPath] = md5;
                console.log(`✅ 轉換完成: ${relativePath}`);
                resolve(outputPath);
            });

        } catch(e){
            console.error(`❌ 處理失敗: ${pdfPath}`, e);
            reject(e);
        }
    });
}

// ================= Trial Link =================

/**
 * 生成隨機 token
 * @returns {string} 16 字元的隨機 token
 */
function generateTrialToken(){
    return crypto.randomBytes(8).toString('hex');
}

/**
 * 為所有 HTML 檔案生成 Trial Links
 * @param {Array} htmlFiles - HTML 檔案路徑陣列
 * @returns {Array} Trial link 資訊陣列
 */
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
        
        // 生成轉址頁面
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
    
    // 追加到 trial_links.txt
    fs.appendFileSync(TRIAL_FILE, logContent, 'utf8');
    console.log('📝 Trial links 已記錄到', TRIAL_FILE);
    
    return links;
}

// ================= 文字處理 =================

/**
 * 從 HTML 中提取純文字
 * @param {string} html - HTML 內容
 * @returns {string} 純文字
 */
function htmlToText(html){
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
}

/**
 * 清理文字（移除數字和特殊符號）
 * @param {string} text - 原始文字
 * @returns {string} 清理後的文字
 */
function cleanText(text){
    return text
        .replace(/[0-9]/g, ' ')
        .replace(/[^\u4e00-\u9fa5a-zA-Z]/g, ' ')
        .replace(/\s+/g, ' ');
}

/**
 * 分詞（中文 + 英文）
 * @param {string} text - 文字
 * @returns {Array} 詞彙陣列
 */
function tokenize(text){
    const wordsCn = jieba.cut(text);
    const wordsEn = text.toLowerCase().split(/\s+/);
    return wordsCn.concat(wordsEn);
}

// ================= TF-IDF =================

/**
 * 建立全域詞頻表
 * @param {Array} htmlFiles - HTML 檔案路徑陣列
 */
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

/**
 * 使用 TF-IDF 提取關鍵字
 * @param {string} text - 文字內容
 * @param {number} topN - 取前 N 個關鍵字
 * @returns {Array} 關鍵字陣列
 */
function extractKeywordsTFIDF(text, topN = 15){
    const words = tokenize(text);
    let tf = {};
    
    // 計算詞頻 (TF)
    words.forEach(w => {
        if(!w || STOPWORDS.includes(w) || w.length < 2) return;
        if(!tf[w]) tf[w] = 0;
        tf[w]++;
    });
    
    // 計算 TF-IDF 分數
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

// ================= Chunk 切分 =================

/**
 * 將文字切分成固定大小的片段
 * @param {string} text - 文字內容
 * @param {number} size - 每個片段的字元數
 * @returns {Array} 文字片段陣列
 */
function splitChunks(text, size = 500){
    let chunks = [];
    for(let i = 0; i < text.length; i += size){
        chunks.push(text.substring(i, i + size));
    }
    return chunks;
}

// ================= Meta & Chunks =================

/**
 * 建立 Meta 資料和 Chunks
 * @param {Array} htmlFiles - HTML 檔案路徑陣列
 */
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
        
        // Chunks
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
    
    // 儲存 JSON
    fs.writeFileSync(path.join(META_FOLDER, 'all_links.json'), JSON.stringify(allLinks, null, 2));
    fs.writeFileSync(path.join(META_FOLDER, 'keywords.json'), JSON.stringify(keywordsList, null, 2));
    fs.writeFileSync(path.join(META_FOLDER, 'ocr_index.json'), JSON.stringify(ocrIndex, null, 2));
    fs.writeFileSync(path.join(META_FOLDER, 'chunks.json'), JSON.stringify(chunksList, null, 2));
    
    console.log('✅ Meta 資料已生成');
}

// ================= Index 生成 =================

/**
 * 生成主索引頁面
 * @param {Array} pdfFiles - PDF 檔案路徑陣列
 */
function generateMainIndex(pdfFiles){
    let html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>📚 PDF 知識庫</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
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

/**
 * 遞迴生成子目錄索引
 * @param {string} dir - 目錄路徑
 */
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
        body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
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

/**
 * 生成 README 連結列表
 * @param {Array} trialLinks - Trial link 資訊陣列
 */
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
                
                // 找對應的 trial link
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

## 系統資訊

- **快取檔案**: \`conversion_cache.json\` (已簽名)
- **Trial 記錄**: \`trial_links.txt\`
- **Meta 資料**: \`site/meta/\`

` + traverse(OUTPUT_FOLDER);
    
    fs.writeFileSync(path.join(OUTPUT_FOLDER, 'README_links.md'), mdContent, 'utf8');
    console.log('✅ README_links.md 已生成');
}

// ================= 主程式 =================

let cache = {}; // 全域變數，在 main() 中初始化

async function main(){
    console.log('🚀 PDF 知識庫系統啟動\n');
    console.log('='.repeat(50));
    
    // 載入快取（含簽名驗證）
    cache = loadCacheWithVerification();
    
    console.log('🔍 掃描 PDF 檔案...');
    const pdfFiles = scanPDFs(PDF_FOLDER);
    
    if(pdfFiles.length === 0){
        console.log('⚠️  未找到任何 PDF 檔案');
        return;
    }
    
    console.log(`📂 找到 ${pdfFiles.length} 個 PDF 檔案\n`);
    console.log('='.repeat(50));
    
    // 轉換 PDF
    for(const pdf of pdfFiles){
        await convertPDF(pdf);
    }
    
    console.log('\n' + '='.repeat(50));
    
    // 儲存快取（含簽名）
    saveCacheWithSignature(cache);
    
    // 生成主索引
    generateMainIndex(pdfFiles);
    
    // 生成子目錄索引
    generateSubIndex(OUTPUT_FOLDER);
    
    // 掃描 HTML
    const htmlFiles = scanHTMLFiles(OUTPUT_FOLDER);
    console.log(`📄 找到 ${htmlFiles.length} 個 HTML 檔案`);
    
    // 建立全域詞頻
    buildGlobalFreq(htmlFiles);
    
    // 生成 Meta & Chunks
    buildMetaAndChunks(htmlFiles);
    
    // 生成 Trial Links
    let trialLinks = [];
    if(ENABLE_TRIAL_LINK){
        trialLinks = generateTrialLinks(htmlFiles);
        console.log(`🔗 已生成 ${trialLinks.length} 個 Trial links`);
    }
    
    // 生成 README
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
