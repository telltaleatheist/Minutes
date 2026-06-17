const fs = require('fs').promises;
const path = require('path');

// RODECaster Track Mappings
const RODECASTER_MAPPINGS = {
  'Stereo Mix': 'master audio',
  'Track1-Combo 1': 'mic 1 audio',
  'Track2-Combo 2': 'mic 2 audio',
  'Track3-USB 1 Main': 'desktop audio',
  'Track4-USB 2': 'screen audio',
  'Track5-Combo 3': 'mic 3 audio',
  'Track6-Sounds': 'sound effects',
  'Track7-Bluetooth': 'bluetooth audio',
  'Track8-Combo 4': 'mic 4 audio',
  'Track9-USB 1 Chat': 'usb chat audio'
};

// Files to auto-check (only master by default, user can select more)
const RODECASTER_AUTO_CHECK = ['master audio'];

// Read RODECaster Meta.xml to get accurate creation timestamp
async function getRodecasterMetadata(folderPath) {
  const metaPath = path.join(folderPath, 'Meta.xml');
  try {
    const content = await fs.readFile(metaPath, 'utf-8');

    const creationMatch = content.match(/<creation>(\d+)<\/creation>/);
    const durationMatch = content.match(/<duration>([\d.]+)<\/duration>/);

    if (creationMatch) {
      const creationMs = parseInt(creationMatch[1]);
      const creationDate = new Date(creationMs);
      const duration = durationMatch ? parseFloat(durationMatch[1]) : 0;

      return {
        creationTime: creationDate,
        duration: duration
      };
    }
  } catch (error) {
    // Meta.xml doesn't exist or couldn't be read
  }
  return null;
}

// Parse RODECaster folder date "1 - 03 December 2025"
function parseRodecasterFolderDate(folderName) {
  const pattern = /\d+ - (\d+) (\w+) (\d{4})/;
  const match = folderName.match(pattern);

  if (!match) return null;

  const day = match[1];
  const month = match[2];
  const year = match[3];

  try {
    const months = {
      January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
      July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };

    const date = new Date(parseInt(year), months[month], parseInt(day));
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');

    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return null;
  }
}

// Format duration for display
function formatDuration(seconds) {
  if (!seconds || seconds === 0) return 'Unknown';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

// Scan output directory for existing finalized sets
async function scanExistingFolders(outputDirectory) {
  const existingByDate = {};

  if (!outputDirectory) {
    return existingByDate;
  }

  try {
    await fs.access(outputDirectory);
    const items = await fs.readdir(outputDirectory);

    for (const item of items) {
      const itemPath = path.join(outputDirectory, item);
      const stat = await fs.stat(itemPath);

      if (stat.isDirectory()) {
        const dateOnlyMatch = item.match(/^(\d{4}-\d{2}-\d{2})$/);
        const dateWithNumMatch = item.match(/^(\d{4}-\d{2}-\d{2}) (\d+)$/);

        if (dateOnlyMatch) {
          const date = dateOnlyMatch[1];
          if (!existingByDate[date]) {
            existingByDate[date] = new Set();
          }
          existingByDate[date].add(0);
        } else if (dateWithNumMatch) {
          const date = dateWithNumMatch[1];
          const num = parseInt(dateWithNumMatch[2]);
          if (!existingByDate[date]) {
            existingByDate[date] = new Set();
          }
          existingByDate[date].add(num);
        }
      }
    }
  } catch (error) {
    // Output directory doesn't exist
  }

  return existingByDate;
}

// Scan RODECaster audio files
async function scanRodecasterFiles(baseDirectory) {
  try {
    await fs.access(baseDirectory);
  } catch {
    return { files: [], sessionsByDate: {} };
  }

  const items = await fs.readdir(baseDirectory);
  const folders = [];

  for (const item of items) {
    const itemPath = path.join(baseDirectory, item);
    const stat = await fs.stat(itemPath);
    if (stat.isDirectory()) {
      folders.push(item);
    }
  }

  if (folders.length === 0) {
    return { files: [], sessionsByDate: {} };
  }

  // Read Meta.xml from each folder
  const folderData = [];
  for (const folder of folders) {
    const folderPath = path.join(baseDirectory, folder);
    const metadata = await getRodecasterMetadata(folderPath);

    if (metadata && metadata.creationTime) {
      const creationDate = metadata.creationTime;
      const yyyy = creationDate.getFullYear();
      const mm = String(creationDate.getMonth() + 1).padStart(2, '0');
      const dd = String(creationDate.getDate()).padStart(2, '0');
      const actualDate = `${yyyy}-${mm}-${dd}`;

      folderData.push({
        folder,
        folderPath,
        date: actualDate,
        startTime: creationDate,
        duration: metadata.duration
      });
    } else {
      const date = parseRodecasterFolderDate(folder);
      if (date) {
        folderData.push({
          folder,
          folderPath,
          date: date,
          startTime: null,
          duration: 0
        });
      }
    }
  }

  // Group folders by date
  const foldersByDate = {};
  for (const data of folderData) {
    if (!foldersByDate[data.date]) {
      foldersByDate[data.date] = [];
    }
    foldersByDate[data.date].push(data);
  }

  // Sort folders within each date by start time
  for (const date in foldersByDate) {
    foldersByDate[date].sort((a, b) => {
      if (a.startTime && b.startTime) {
        return a.startTime.getTime() - b.startTime.getTime();
      }
      return a.folder.localeCompare(b.folder);
    });
  }

  const results = [];
  const sessionsByDate = {};

  for (const date of Object.keys(foldersByDate).sort()) {
    const dateFolders = foldersByDate[date];
    sessionsByDate[date] = [];

    for (let sessionNum = 0; sessionNum < dateFolders.length; sessionNum++) {
      const folderInfo = dateFolders[sessionNum];
      const folderPath = folderInfo.folderPath;
      const folder = folderInfo.folder;

      const files = await fs.readdir(folderPath);
      const wavFiles = files.filter(f => f.endsWith('.wav'));

      const sessionFiles = [];
      let sessionDuration = folderInfo.duration;

      for (const filename of wavFiles) {
        const baseName = filename.slice(0, -4);

        // Only include Stereo Mix (master audio) files
        if (!baseName.includes('Stereo Mix')) {
          continue;
        }

        const fileData = {
          id: `audio-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          source: 'rodecaster',
          originalName: filename,
          newName: '',
          fullPath: path.join(folderPath, filename),
          folder: folder,
          date: date,
          baseName: 'master audio',
          duration: sessionDuration,
          durationFormatted: formatDuration(sessionDuration),
          checked: true  // Always checked since it's the only option
        };
        sessionFiles.push(fileData);
        results.push(fileData);
      }

      sessionsByDate[date].push({
        sessionIndex: sessionNum,
        duration: sessionDuration,
        startTime: folderInfo.startTime,
        files: sessionFiles
      });
    }
  }

  return { files: results, sessionsByDate };
}

// Scan audio sources and create file sets
async function scanAudioSources(rodecasterDirectory, outputDirectory) {
  const [rodecasterResult, existingFolders] = await Promise.all([
    scanRodecasterFiles(rodecasterDirectory),
    scanExistingFolders(outputDirectory)
  ]);

  const audioFiles = rodecasterResult.files;
  const sessionsByDate = rodecasterResult.sessionsByDate;

  const fileSets = [];

  for (const date of Object.keys(sessionsByDate).sort().reverse()) {
    const sessions = sessionsByDate[date];

    // Reverse sessions so newest appears first within each date
    for (let sessionNum = sessions.length - 1; sessionNum >= 0; sessionNum--) {
      const session = sessions[sessionNum];
      const totalSets = sessions.length;
      const setName = totalSets > 1 ? `${date} ${sessionNum + 1}` : date;

      // Update file names
      for (const file of session.files) {
        file.newName = `${setName} ${file.baseName}.wav`;
      }

      fileSets.push({
        name: setName,
        date: date,
        session: sessionNum + 1,
        audioFiles: session.files,
        duration: session.duration,
        durationFormatted: formatDuration(session.duration),
        startTime: session.startTime
      });
    }
  }

  // Re-number sets accounting for existing folders
  const setsByDate = {};
  for (const set of fileSets) {
    if (!setsByDate[set.date]) {
      setsByDate[set.date] = [];
    }
    setsByDate[set.date].push(set);
  }

  for (const date of Object.keys(setsByDate)) {
    const dateSets = setsByDate[date];
    const existingNums = existingFolders[date] || new Set();
    const totalSets = dateSets.length + existingNums.size;

    let nextNum = 1;
    for (let i = 0; i < dateSets.length; i++) {
      while (existingNums.has(nextNum) || (existingNums.has(0) && nextNum === 1)) {
        nextNum++;
      }

      let newName;
      if (totalSets > 1) {
        newName = `${date} ${nextNum}`;
      } else {
        newName = date;
      }

      const set = dateSets[i];
      set.name = newName;
      set.session = nextNum;

      for (const file of set.audioFiles) {
        file.newName = `${newName} ${file.baseName}.wav`;
      }

      nextNum++;
    }
  }

  return {
    fileSets,
    audioFiles
  };
}

// Finalize a single file set
async function finalizeFileSet(fileSet, outputBaseDirectory, onProgress) {
  const results = {
    setName: fileSet.name,
    targetFolder: path.join(outputBaseDirectory, fileSet.name),
    success: [],
    errors: []
  };

  const checkedFiles = fileSet.audioFiles.filter(f => f.checked);
  const totalFiles = checkedFiles.length;
  let processedFiles = 0;

  // Create target folder
  try {
    await fs.mkdir(results.targetFolder, { recursive: true });
  } catch (error) {
    results.errors.push({
      type: 'folder',
      message: `Failed to create folder: ${error.message}`
    });
    return results;
  }

  // Track source folders for cleanup
  const sourceFoldersToClean = new Set();

  for (const file of checkedFiles) {
    const targetPath = path.join(results.targetFolder, file.newName);

    if (onProgress) {
      onProgress(processedFiles, totalFiles, file.newName, 'Moving');
    }

    try {
      // Check if target exists
      try {
        await fs.access(targetPath);
        results.errors.push({
          type: 'audio',
          file: file.newName,
          message: 'File already exists in target folder'
        });
        processedFiles++;
        continue;
      } catch {
        // Good, file doesn't exist
      }

      // Copy then delete (for RODECaster files on SD card)
      await fs.copyFile(file.fullPath, targetPath);
      await fs.unlink(file.fullPath);

      sourceFoldersToClean.add(path.dirname(file.fullPath));

      results.success.push({
        type: 'audio',
        originalName: file.originalName,
        newName: file.newName,
        action: 'moved'
      });
    } catch (error) {
      results.errors.push({
        type: 'audio',
        file: file.originalName,
        message: error.message
      });
    }
    processedFiles++;
  }

  // Clean up empty source folders
  for (const folder of sourceFoldersToClean) {
    try {
      const remaining = await fs.readdir(folder);
      if (remaining.length === 0) {
        await fs.rmdir(folder);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  if (onProgress) {
    onProgress(totalFiles, totalFiles, 'Complete', 'Done');
  }

  return results;
}

// Finalize multiple file sets
async function finalizeFileSets(fileSets, outputBaseDirectory, onProgress) {
  const allResults = [];

  let totalFiles = 0;
  let processedFiles = 0;

  const setsToProcess = fileSets.filter(fileSet => {
    return fileSet.audioFiles.some(f => f.checked);
  });

  for (const fileSet of setsToProcess) {
    totalFiles += fileSet.audioFiles.filter(f => f.checked).length;
  }

  const progressWrapper = (current, setTotal, filename, action) => {
    if (onProgress) {
      onProgress(processedFiles + current, totalFiles, filename, action);
    }
  };

  for (const fileSet of setsToProcess) {
    const setFileCount = fileSet.audioFiles.filter(f => f.checked).length;
    const result = await finalizeFileSet(fileSet, outputBaseDirectory, progressWrapper);
    allResults.push(result);
    processedFiles += setFileCount;
  }

  return allResults;
}

// Process dropped files/folders
async function processDroppedFiles(paths, setName) {
  const files = [];

  for (const droppedPath of paths) {
    try {
      const stat = await fs.stat(droppedPath);

      if (stat.isDirectory()) {
        // It's a RODECaster folder
        const folderFiles = await fs.readdir(droppedPath);
        const wavFiles = folderFiles.filter(f => f.endsWith('.wav'));

        if (wavFiles.length > 0) {
          const metadata = await getRodecasterMetadata(droppedPath);
          const duration = metadata?.duration || 0;

          for (const filename of wavFiles) {
            const baseName = filename.slice(0, -4);

            let mappedName = null;
            for (const [trackName, name] of Object.entries(RODECASTER_MAPPINGS)) {
              if (baseName.includes(trackName)) {
                mappedName = name;
                break;
              }
            }

            if (mappedName) {
              const shouldCheck = RODECASTER_AUTO_CHECK.includes(mappedName);

              files.push({
                id: `audio-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                source: 'rodecaster',
                originalName: filename,
                newName: `${setName} ${mappedName}.wav`,
                fullPath: path.join(droppedPath, filename),
                folder: path.basename(droppedPath),
                date: setName.split(' ')[0],
                baseName: mappedName,
                duration: duration,
                durationFormatted: formatDuration(duration),
                checked: shouldCheck
              });
            }
          }
        }
      } else if (stat.isFile() && droppedPath.endsWith('.wav')) {
        // Single wav file
        const filename = path.basename(droppedPath);
        const baseName = filename.slice(0, -4);

        let mappedName = null;
        for (const [trackName, name] of Object.entries(RODECASTER_MAPPINGS)) {
          if (baseName.includes(trackName)) {
            mappedName = name;
            break;
          }
        }

        if (!mappedName) {
          mappedName = baseName;
        }

        const shouldCheck = RODECASTER_AUTO_CHECK.includes(mappedName);

        files.push({
          id: `audio-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          source: 'rodecaster',
          originalName: filename,
          newName: `${setName} ${mappedName}.wav`,
          fullPath: droppedPath,
          folder: path.dirname(droppedPath),
          date: setName.split(' ')[0],
          baseName: mappedName,
          duration: 0,
          durationFormatted: 'Unknown',
          checked: shouldCheck
        });
      }
    } catch (error) {
      console.error(`Error processing dropped path ${droppedPath}:`, error.message);
    }
  }

  return { files };
}

export {
  scanAudioSources,
  finalizeFileSet,
  finalizeFileSets,
  processDroppedFiles
};
