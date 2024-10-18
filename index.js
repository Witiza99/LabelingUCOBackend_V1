/*******************************Imports***********************************/
const express = require('express');
const { ExifTool } = require('exiftool-vendored');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { spawn } = require('child_process');
const os = require('os');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

/****************************Conf/Variable***********************************/
const app = express();
const PORT = process.env.PORT || 3001;
const exiftool = new ExifTool();

// Cors conf
const corsOptions = {
    origin: (origin, callback) => {
        const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:4201').split(',');

        // Registrar el origen de la solicitud
        console.log('Solicitud recibida desde el origen:', origin);
        // Log para verificar los orígenes permitidos
        console.log('Orígenes permitidos:', allowedOrigins);

        // Verificar si el origen está permitido
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            console.log('Origin allowed:', origin); // Log si el origen está permitido
            callback(null, true); // Permitir el origen
        } else {
            console.log('Origin not allowed:', origin); // Log si el origen no está permitido
            callback(new Error('Not allowed by CORS')); // Bloquear el origen
        }
    },
    optionsSuccessStatus: 200 // Para manejar correctamente el status de las opciones
};



// Multer conf
const upload = multer({ dest: os.tmpdir() });


app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));

/***********test*********/
/*
// Middleware to test incoming requests
app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    console.log('Encabezados:', req.headers);
    console.log('Cuerpo:', req.body);
    next();
});*/


/*******************************API***********************************/
// Endpoint to test backend
app.get('/test', (req, res) => {
    res.json({ message: 'Hello world' });
  });

// Get file and frame rate, return zip with images from video processing
app.post('/api/process-video', upload.array('files'), async (req, res) => {
    const frameRates = JSON.parse(req.body.frameRates);
    console.log(frameRates);
    const files = req.files;
    const processedFiles = [];

    // Generate UUID for this
    const requestId = uuidv4();
    const outputDir = path.join(os.tmpdir(), 'processed_images_${requestId}');
    // Delete dir outputDir if exists
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true });
    }

    // Create new outputDir
    fs.mkdirSync(outputDir);

    try {
        for (let i = 0; i < files.length; i++) {
            console.log("Processing file " + i);
            const videoPath = files[i].path;
            const frameRate = frameRates[i];
            console.log("Take max FPS -> ");
            const maxFrameRate = await getMaxFrameRate(videoPath);
            console.log(maxFrameRate);
            console.log("Processing Video to Images");
            const outputImages = await processVideo(videoPath, frameRate, maxFrameRate, outputDir, i);
            console.log("Ending Video to Images");
            processedFiles.push(...outputImages);
        }

        console.log("Creating zip...");
        // Zip name
        const zipFileName = 'processed_files.zip';

        // Zip Conf
        const archive = archiver('zip', {
            zlib: { level: 9 } // Max lvl compression
        });

        // Conf Zip to res
        res.attachment(zipFileName);
        archive.pipe(res);

         processedFiles.forEach(filePath => {
            const fileName = path.basename(filePath); 
            console.log("Add image -> " + fileName);
            archive.append(fs.createReadStream(filePath), { name: fileName });
        });

        // Send ZIP
        archive.finalize();

        // Event for check if zip is send
        archive.on('end', () => {
            console.log('Zip was sent');
        });

        archive.on('error', (err) => {
            console.error('Error creating zip:', err);
            res.status(500).send({ error: 'Error creating zip.' });
        });
        
    } catch (error) {
        console.error('Error processing files:', error);
        res.status(500).json({ error: 'Error processing files.' });
    }
});

// Get image and metadata, return image with image and metadata
app.post('/api/add-metadata', upload.single('imagen'), async (req, res) => {
    const jsonMetadata = req.body.jsonMetadata;
    const { path: imagePath } = req.file;
    console.log(jsonMetadata);

    try {
        if (fs.existsSync(imagePath)) {
            // Write on tag UserComment
            await exiftool.write(imagePath, { UserComment: jsonMetadata });
            console.log('UserComment written successfully');

            const modifiedImagePath = path.isAbsolute(imagePath) ? imagePath : path.join(__dirname, imagePath);

            // Read all tags
            const tags = await exiftool.read(modifiedImagePath);
            console.log(`Tags: ${JSON.stringify(tags, null, 2)}`);

            // Check if UserComment exist
            if (tags.UserComment) {
                console.log(`UserComment: ${tags.UserComment}`);
            } else {
                console.error('UserComment not found in tags');
            }

            res.sendFile(modifiedImagePath)
        } else {
            console.error("The specified image path does not exist.");
            res.status(400).json({ error: 'The specified image path does not exist.' });
        }
    } catch (error) {
        console.error('Error embedding metadata in image:', error);
        res.status(500).json({ error: 'Error embedding metadata in image.' });
    }
});

app.listen(PORT, () => {
    console.log(`Backend server start port ${PORT}`);
});

/*******************************FUNCTIONS***********************************/

// Function to get Max Frame Rate
async function getMaxFrameRate(videoPath) {
    return new Promise((resolve, reject) => {
        // Args for ffprobe to get max frame rate
        const ffprobeArgs = [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=r_frame_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            videoPath
        ];

        const ffprobeProcess = spawn('ffprobe', ffprobeArgs);

        ffprobeProcess.stdout.on('data', (data) => {
            const fps = parseFloat(data.toString().trim());
            resolve(fps);
        });

        ffprobeProcess.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
            reject(data.toString());
        });

        ffprobeProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`ffprobe had error ${code}`);
                reject(`ffprobe had error ${code}`);
            }
        });

        ffprobeProcess.on('error', (err) => {
            console.error('Error with ffprobe:', err);
            reject(err);
        });
    });
}

// Function to get Files path from directory
function getFilePathsInDirectory(directory) {
    const files = fs.readdirSync(directory);
    return files.map(file => path.join(directory, file));
}

// Function to process Video 
async function processVideo(videoPath, requestedFrameRate, maxFrameRate, outputDir, i) {
    return new Promise((resolve, reject) => {
        let outputImages = [];

        const frameRate = Math.min(requestedFrameRate, maxFrameRate);

        const ffmpegArgs = [
            '-i', videoPath,
            '-vf', `fps=${frameRate}`,
            path.join(outputDir, `${i}-frame-%d.png`)
        ];

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                // Get paths
                let imagePaths = getFilePathsInDirectory(outputDir);
                // Sort image paths
                imagePaths = imagePaths.sort((a, b) => {
                    const aMatch = a.match(/(\d+)\.png$/); // Extrae el número del fotograma del nombre del archivo 'a'
                    const bMatch = b.match(/(\d+)\.png$/); // Extrae el número del fotograma del nombre del archivo 'b'

                    if (aMatch && bMatch) {
                        return parseInt(aMatch[1], 10) - parseInt(bMatch[1], 10); // Compara los números de los fotogramas
                    }
                    return 0; // Si no se puede extraer el número, no cambia el orden
                });
                resolve(imagePaths);
            } else {
                reject(`Error with FFmpeg -> ${code}`);
            }
        });

        ffmpegProcess.on('error', (err) => {
            reject(err);
        });
    });
}


/*******************************SIGNALS***********************************/
// End exiftool
process.on('exit', async () => {
    await exiftool.end();
});

// Control SIGINT 
process.on('SIGINT', async () => {
    try {
        await exiftool.end();
        console.log('ExifTool finalizado correctamente.');
        process.exit();
    } catch (err) {
        console.error('Error al finalizar ExifTool:', err);
        process.exit(1);
    }
});


