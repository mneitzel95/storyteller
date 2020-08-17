const vscode = require('vscode');
const spawn = require('child_process').spawn;
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');

//main interface with the storyteller server
const ProjectManager = require('./core/project/ProjectManager');

//holds a reference to the storyteller project manager
let projectManager = null;

//keeps track if storyteller is currently active in a directory
let isStorytellerCurrentlyActive = false;

//this is an array of file/dir paths of recently created items.
let recentlyCreatedFileOrDir = [];

//this is the number of milliseconds to wait after receiving a create file
//event to see if there is a corresponding delete event indicating a 
//move/rename
const waitForDeleteEventTimeout = 10;

//this holds information about code copied to the clipboard. This is used to 
//track cut/copy and pastes
const clipboardData = {
    text: '',
    eventIds: [],
    activePaste: false
};

//disposables for overriding cut/copy/paste functionality
let clipboardCopyDisposable; 
let clipboardCutDisposable; 
let clipboardPasteDisposable; 

//storyteller status bar
let storytellerStatusBarItem = null;

//the vscode extension's context 
let extensionContext;

/*
 * Called when activating the extension.
 */
function activate(context) {
    //store the context
    extensionContext = context;

    //register storyteller commands for this plugin  
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.startStoryteller', startStoryteller));
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.stopStoryteller', stopStoryteller));
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.startPlaybackNoComment', startPlaybackNoComment));
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.startPlaybackToMakeAComment', startPlaybackToMakeAComment));
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.storytellerState', storytellerState));
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.currentActiveDevelopers', currentActiveDevelopers));
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.createNewDeveloper', createNewDeveloper));
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.addDevelopersToActiveGroup', addDevelopersToActiveGroup));
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.removeDevelopersFromActiveGroup', removeDevelopersFromActiveGroup));
    extensionContext.subscriptions.push(vscode.commands.registerCommand('storyteller.zipProject', zipProject));

    //if there is an open workspace then attempt to open storyteller without requiring user interaction
    if(vscode.workspace.workspaceFolders) {
        //path to the hidden .storyteller dir in every storyteller project 
        const pathToHiddenStorytellerDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.storyteller');
        
        //if there is a .storyteller dir
        if(fs.existsSync(pathToHiddenStorytellerDir)) {
            //give a startup message in the status bar
            updateStorytellerStatusBar('Starting Storyteller $(sync~spin)', 'Starting Storyteller- please do not edit any files of dirs until this is complete', 'storyteller.storytellerState');
            
            //don't want to slow down the init of the system so we do the more expensive operations a little later
            setTimeout(function() {
                //init storyteller without a prompt
                startStoryteller();
            }, 1);
        } else { //there is an open directory but it does not have a .storyteller dir in it
            //don't start tracking unless the user chooses to use storyteller
            //add a button to the status bar so the user can start using storyteller
            updateStorytellerStatusBar('Start Storyteller', 'Start using Storyteller in this workspace', 'storyteller.startStoryteller');

            //show a message informing the user that they can use storyteller if they wish
            promptInformingAboutUsingStoryteller(false);
        }
    } else { //there is no open workspace
        //add a button to the status bar so the user can start using storyteller
        updateStorytellerStatusBar('Start Storyteller', 'Start using Storyteller in this workspace', 'storyteller.startStoryteller');   

        //show a message informing the user that they can use storyteller if they wish
        promptInformingAboutUsingStoryteller(true);
    }
}
/*
 * Called when deactivating the extension.
 */
function deactivate() {
    //stop tracking this project
    stopStoryteller();
}
/*
 * Creates or opens a new Storyteller project in a workspace.
 */
function startStoryteller() {
    //st is already active
    if(isStorytellerCurrentlyActive) {
        //let them know about the current state
        storytellerState();
    } else { //st is not active
        //if there is an open workspace
        if(vscode.workspace.workspaceFolders) {
            //check to see if there is a .storyteller directory before creating 
            //the project manager
            const projectExists = fs.existsSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.storyteller'));

            //if this is an existing project
            if(projectExists === true) {
                //resume working on an existing project
                resumeExistingProject();
            } else { //this is a brand new project
                //start tracking changes in this folder
                startTrackingInFolder();
            }
        } else { //there is no open workspace
            //tell the user they need to open a workspace in order to use Storyteller
            promptInformingAboutUsingStoryteller(true);
        }
    }
}
/*
 * Used to stop tracking a project.
 */
function stopStoryteller() {
    //clear out any values that might still be in this array.
    recentlyCreatedFileOrDir = [];

    //if storyteller is active
    if(isStorytellerCurrentlyActive) {
        //close the project
        projectManager.stopStoryteller();

        //update the status bar
        updateStorytellerStatusBar('Start Storyteller', 'Start using Storyteller in this workspace', 'storyteller.startStoryteller');

        //tell the user they need to open a workspace in order to use Storyteller
        promptInformingAboutUsingStoryteller(false);

        //indicate that storyteller is no longer active
        isStorytellerCurrentlyActive = false;

        //clean up the cut/copy and paste disposables
        clipboardCopyDisposable.dispose();
        clipboardCutDisposable.dispose();
        clipboardPasteDisposable.dispose();
    } else { //there is no open workspace
        //tell the user they need to open a workspace in order to use Storyteller
        promptInformingAboutUsingStoryteller(false);
    }
}
/*
 * Used to resume an existing st project. This is where reconciliation happens
 * if it is needed.
 */
function resumeExistingProject() {
    //check to see if there is a .storyteller directory 
    const projectExists = fs.existsSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.storyteller'));
   
    //if a folder is open and there is a .storyteller directory in it
    if(vscode.workspace.workspaceFolders && projectExists === true) {
        //create and store the global project manager in the opened directory
        projectManager = new ProjectManager(vscode.workspace.workspaceFolders[0].uri.fsPath);

        //ask for any discrepancies between the open project and the file system
        const discrepancies = projectManager.reconciler.findDiscrepancies();

        //if there is at least one discrepancy
        if(areDiscrepanciesPresent(discrepancies)) {
            //let the user know they have to resolve some discrepancies
            vscode.window.showInformationMessage(`There were some changes to the project when Storyteller wasn't active. In a moment you will be prompted to resolve the discrepancies.`);
            //ask the user to decide how to handle them
            resolveFileSystemDescrepancies(discrepancies);
        } else { //there are no discrepancies
            //turn on file watching
            turnOnFSWatcherAndTextHandler();
            //give the user some feedback about starting storyteller in an info message
            storytellerState();
        }
        //update the status bar
        updateStorytellerStatusBar('Start Playback', 'Start a Storyteller playback in the browser', 'storyteller.startPlaybackNoComment');
   }
}
/*
* Used to start tracking a new project. If the open folder is not empty then 
* the contents of the existing files will be added to the history of the system.
*/
async function startTrackingInFolder() {
   //check to see if there is a .storyteller directory 
   const projectExists = fs.existsSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.storyteller'));
   
   //if a folder is open and there is not a .storyteller directory in it
   if(vscode.workspace.workspaceFolders && projectExists === false) {
        //create and store the global project manager in the opened directory
        projectManager = new ProjectManager(vscode.workspace.workspaceFolders[0].uri.fsPath);

        //ask for any discrepancies between the open project and the file system
        const discrepancies = projectManager.reconciler.findDiscrepancies();
        //holds the number of existing files and directories in the new project
        const existingFilesDirs = discrepancies.fullDirPathsPresentButNotTracked.length + discrepancies.fullFilePathsPresentButNotTracked.length;
        //if there are any files/dirs in the new project
        if(existingFilesDirs > 0) {
            //add them to the project
            projectManager.reconciler.addExistingFilesDirs(discrepancies);
        }
        //turn on file watching
        turnOnFSWatcherAndTextHandler();

        //prompt for the first developer's info
        createFirstDeveloper();

        //update the status bar
        updateStorytellerStatusBar('Start Playback', 'Start a Storyteller playback in the browser', 'storyteller.startPlaybackNoComment');
   }
}
/*
 * Turns the file system watcher, text change handler, and save handler on.
 * This doesn't happen until the user chooses to use Storyteller.
 */
function turnOnFSWatcherAndTextHandler() {
    //register a handler to capture changes to files in the editor
    extensionContext.subscriptions.push(vscode.workspace.onDidChangeTextDocument(handleTextEditorChange));
    //register a handler to be called whenever the user saves one or more files
    extensionContext.subscriptions.push(vscode.workspace.onDidSaveTextDocument(handleFileSave));
    //create a file system watcher for all of the files in this workspace
    const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    //handle file/dir creates and deletes (translate these to create, delete, move, rename events) 
    extensionContext.subscriptions.push(fsWatcher.onDidCreate(addRecentCreate));
    extensionContext.subscriptions.push(fsWatcher.onDidDelete(addRecentDelete));
    
    //cut/copy/paste overides
    //override the editor.action.clipboardCopyAction with our own
    clipboardCopyDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardCopyAction', overriddenClipboardCopyAction); 
    //extensionContext.subscriptions.push(clipboardCopyDisposable);

    //override the editor.action.clipboardCutAction with our own
    clipboardCutDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardCutAction', overriddenClipboardCutAction); 
    //extensionContext.subscriptions.push(clipboardCutDisposable);

    //override the editor.action.clipboardPasteAction with our own
    clipboardPasteDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardPasteAction', overriddenClipboardPasteAction); 
    //extensionContext.subscriptions.push(clipboardPasteDisposable);

    //indicate that storyteller is active
    isStorytellerCurrentlyActive = true;
}
/* 
 * This function creates the storyteller status button (if it doesn't already exist) 
 * and updates it.
 */
function updateStorytellerStatusBar(text, tooltip, command) {
    //if the status bar has not been created yet
    if(storytellerStatusBarItem === null) {
        //add a storyteller item to the status bar
        storytellerStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);    
        storytellerStatusBarItem.text = text;
        storytellerStatusBarItem.tooltip = tooltip;
        storytellerStatusBarItem.command = command;
        storytellerStatusBarItem.show();
    } else { //the status bar has been created
        //update the existing status bar
        storytellerStatusBarItem.text = text;
        storytellerStatusBarItem.tooltip = tooltip;
        storytellerStatusBarItem.command = command;
    }
}
/****************************** Reconciliation  *******************************/
/*
 * Indicates if there is at least one discrepancy during reconciliation.
 */
function areDiscrepanciesPresent(discrepancies) {
    //count all of the discrepancies that were found
    const numDiscrepancies = discrepancies.fullDirPathsPresentButNotTracked.length + 
    discrepancies.fullFilePathsPresentButNotTracked.length +
    discrepancies.missingDirectoryIds.length + 
    discrepancies.missingFileIds.length +
    discrepancies.modifiedFileIds.length;

    //return whether there were more than one
    return (numDiscrepancies > 0);
}
/*
 * Begins the reconciliation process. The helper functions have to be called
 * in order because of the promise based UI. The user will be prompted to 
 * choose what to do with files and dirs that have been modified outside of 
 * Storyteller, files and dirs currently not being tracked, and files and 
 * dirs that are missing.
 */
function resolveFileSystemDescrepancies(discrepancies) {
    //start the sequential process of the user resolving discrepancies
    resolveModified(discrepancies);
    //at the end of resolveModified() will call:
    //resolveUntracked(discrepancies);
    //at the end of resolveUntracked() will call:
    //resolveMissing(discrepancies);
    //at the end of resolveMissing() will call:
    //reconcileComplete();
}
/*
 * Handles files that were modified outside of st.
 */
async function resolveModified(discrepancies) {
    //count how many modified files there are
    const numModified = discrepancies.modifiedFileIds.length;

    //if there are some that need to be resolved by the user
    if(numModified > 0) {
        //ask the user what they want to do with the modified files 
        const options = ['Add the changes in the files to the history of this project', 'Ignore the changes to the files'];
        const selectedOption = await vscode.window.showQuickPick(options, {placeHolder: `There are ${numModified} modified files. What would you like to do with them?`});
        
        //if the user does not choose an option OR they want to accept the changes in the files
        if(!selectedOption || options.indexOf(selectedOption) === 0) {
            //accept changes made to the files
            for(let i = 0;i < discrepancies.modifiedFileIds.length;i++) {
                const fileId = discrepancies.modifiedFileIds[i];
                //accept changes to the storyteller state
                projectManager.reconciler.resolveFileChanges(fileId, 'accept-changes');
            }

            //let the user know what happened
            vscode.window.showInformationMessage(`Accepted the changes made in ${numModified} files. Files: ${discrepancies.modifiedFileIds.map(fileId => projectManager.fileSystemManager.allFiles[fileId].currentPath).join(', ')}`);
        } else if(options.indexOf(selectedOption) === 1) {
            //abandon changes made to the files
            for(let i = 0;i < discrepancies.modifiedFileIds.length;i++) {
                const fileId = discrepancies.modifiedFileIds[i];
                //abandon change to the storyteller state
                projectManager.reconciler.resolveFileChanges(fileId, 'recreate');
            }

            //let the user know what happened
            vscode.window.showInformationMessage(`Abandoned the changes made in ${numModified} files.  Files: ${discrepancies.modifiedFileIds.map(fileId => projectManager.fileSystemManager.allFiles[fileId].currentPath).join(', ')}`);
        }
    }

    //move on to the next type of discrepancy
    resolveUntracked(discrepancies);
}
/*
 * Handles untracked (newly added when st was not active) files and dirs. 
 */
async function resolveUntracked(discrepancies) {
    //count how many untracked files and dirs there are
    const numNotTracked = discrepancies.fullDirPathsPresentButNotTracked.length + discrepancies.fullFilePathsPresentButNotTracked.length;
    
    //if there are some that need to be resolved by the user
    if(numNotTracked > 0) {
        //ask the user what they want to do with the new, untracked files and dirs
        const options = ['Add the new files/dirs to the project', 'Delete the new files/dirs'];
        const selectedOption = await vscode.window.showQuickPick(options, {placeHolder: `There are ${numNotTracked} untracked files and dirs. What would you like to do with them?`});
        
        //if the user does not choose an option OR they want to add and track the new files/dirs
        if(!selectedOption || options.indexOf(selectedOption) === 0) {
            //create and start tracking the new directories
            for(let i = 0;i < discrepancies.fullDirPathsPresentButNotTracked.length;i++) {
                const newDirPath = discrepancies.fullDirPathsPresentButNotTracked[i];
                //create the new directory
                projectManager.reconciler.resolveNewDirectory(newDirPath, 'create');
            }

            //create and start tracking the new files
            for(let i = 0;i < discrepancies.fullFilePathsPresentButNotTracked.length;i++) {
                const newFilePath = discrepancies.fullFilePathsPresentButNotTracked[i];
                //create the new file
                projectManager.reconciler.resolveNewFile(newFilePath, 'create');
            }

            //let the user know what happened
            vscode.window.showInformationMessage(`${numNotTracked} files and dirs are now being tracked. Directories: ${discrepancies.fullDirPathsPresentButNotTracked.join(', ')} Files: ${discrepancies.fullFilePathsPresentButNotTracked.join(', ')}`);
        } else if(options.indexOf(selectedOption) === 1) {
            //delete the new files first
            for(let i = 0;i < discrepancies.fullFilePathsPresentButNotTracked.length;i++) {
                const newFilePath = discrepancies.fullFilePathsPresentButNotTracked[i];
                //create the new file
                projectManager.reconciler.resolveNewFile(newFilePath, 'delete');
            }

            //remove the directories- the array is generated in a top down way
            //reverse to remove from the bottom of the file system up towards 
            //the top
            discrepancies.fullDirPathsPresentButNotTracked.reverse();
            //delete the new directories
            for(let i = 0;i < discrepancies.fullDirPathsPresentButNotTracked.length;i++) {
                const newDirPath = discrepancies.fullDirPathsPresentButNotTracked[i];
                //create the new directory
                projectManager.reconciler.resolveNewDirectory(newDirPath, 'delete');
            }

            //let the user know what happened
            vscode.window.showInformationMessage(`${numNotTracked} files and dirs were deleted. Directories: ${discrepancies.fullDirPathsPresentButNotTracked.join(', ')} Files: ${discrepancies.fullFilePathsPresentButNotTracked.join(', ')}`);
        }
    } 
    //move on to the next type of discrepancy
    resolveMissing(discrepancies);
}
/*
 * Handles missing files and dirs (were in st db but were deleted when st was
 * not active). 
 */
async function resolveMissing(discrepancies) {
    //count how many missing files and dirs there are
    const numMissing = discrepancies.missingDirectoryIds.length + discrepancies.missingFileIds.length;
    
    //if there are some that need to be resolved by the user
    if(numMissing > 0) {
        //ask the user what they want to do with the missing files and dirs
        const options = ['Add the missing files/dirs back to the project', 'Leave the missing files/dirs out of the project'];
        const selectedOption = await vscode.window.showQuickPick(options, {placeHolder: `There are ${numMissing} missing files and directories. What would you like to do with them?`});
        
        //if the user does not choose an option OR they want to continue to track the missing files/dirs
        if(!selectedOption || options.indexOf(selectedOption) === 0) {
            //recreate the missing new directories
            for(let i = 0;i < discrepancies.missingDirectoryIds.length;i++) {
                const dirId = discrepancies.missingDirectoryIds[i];
                //recreate the directory
                projectManager.reconciler.resolveDeletedDirectory(dirId, 'recreate');
            }

            //recreate the missing files
            for(let i = 0;i < discrepancies.missingFileIds.length;i++) {
                const fileId = discrepancies.missingFileIds[i];
                //recreate the file
                projectManager.reconciler.resolveDeletedFile(fileId, 'recreate');
            }

            //let the user know what happened
            vscode.window.showInformationMessage(`${numMissing} files and dirs have been restored. Directories: ${discrepancies.missingDirectoryIds.map(dirId => projectManager.fileSystemManager.allDirs[dirId].currentPath).join(', ') } Files: ${discrepancies.missingFileIds.map(fileId => projectManager.fileSystemManager.allFiles[fileId].currentPath).join(', ')}`);
        } else if(options.indexOf(selectedOption) === 1) {
            //accept that the missing new files will stay deleted
            for(let i = 0;i < discrepancies.missingFileIds.length;i++) {
                const fileId = discrepancies.missingFileIds[i];
                //delete the file
                projectManager.reconciler.resolveDeletedFile(fileId, 'accept-delete');
            }
            //accept that the missing new directories will stay deleted
            for(let i = 0;i < discrepancies.missingDirectoryIds.length;i++) {
                const dirId = discrepancies.missingDirectoryIds[i];
                //delete the directory
                projectManager.reconciler.resolveDeletedDirectory(dirId, 'accept-delete');
            }

            //let the user know what happened
            vscode.window.showInformationMessage(`${numMissing} files and dirs will remain deleted. Directories: ${discrepancies.missingDirectoryIds.map(dirId => projectManager.fileSystemManager.allDirs[dirId].currentPath).join(', ') } Files: ${discrepancies.missingFileIds.map(fileId => projectManager.fileSystemManager.allFiles[fileId].currentPath).join(', ')}`);
        }
    }

    //move on to the next type of reconciliation 
    reconcileComplete();
}
/*
 * This is used to indicate that each of the three types of issues (modified, 
 * untracked, missing) are complete. When they are all complete the user
 * will be notified and they will be asked to continue using Storyteller or
 * to stop using it.
 */
async function reconcileComplete() {
    //let the user know reconciliation is complete and ask them if they 
    //want to continue using Storyteller
    const options = ['Continue using Storyteller', 'Stop using Storyteller'];
    const selectedOption = await vscode.window.showQuickPick(options, {placeHolder: `Reconcile complete. Do you want to continue using Storyteller?`});

    //if the user does not choose an option OR they want to continue using st
    if(!selectedOption || options.indexOf(selectedOption) === 0) {
        //turn on file watching since reconciliation is complete
        turnOnFSWatcherAndTextHandler();
    } else if(options.indexOf(selectedOption) === 1) { //stop using st
        projectManager.stopStoryteller();
    }
}
/********************************** Playback **********************************/
/*
 * Start a playback at the very beginning of the development.
 */
function startPlaybackNoComment() {
    //if storyteller is active
    if(isStorytellerCurrentlyActive) {
        //start a playback at the beginning
        startPlayback(false);
    } else { //storyteller not active
        //tell the user how they can use storyteller
        promptInformingAboutUsingStoryteller(true);
    }
}
/*
 * Start a playback at the end of the development so that the user can add a comment.
 */
function startPlaybackToMakeAComment() {
    //if storyteller is active
    if(isStorytellerCurrentlyActive) {
        //start a playback at the end so the user can add a comment to the latest code
        startPlayback(true);
    } else { //storyteller not active
        //tell the user how they can use storyteller
        promptInformingAboutUsingStoryteller(true);
    }
}
/*
 * Helper function to start a playback in the browser. If the user passes in true for 
 * playbackIsForAComment then the playback starts at the end and a user can add a 
 * comment to the latest code. Otherwise it starts at the beginning.
 */ 
function startPlayback(playbackIsForAComment) {
    //if we are tracking changes
    if(isStorytellerCurrentlyActive) {
        //save the state of the storyteller data for this project
        handleFileSave();

        //Display a message box to the user fo 5000 ms (5 s)
        vscode.window.setStatusBarMessage('Storyteller Playback Server at localhost:53140/playback', 5000);

        //open a browser window with the playback's URL (at the beginning if not for comments, at the end if it is for comments)
        openPlaybackInBrowser(playbackIsForAComment);  
    } //message displayed in functions calling this helper
}
/*
 * Opens a browser window to display a playback.
 */
function openPlaybackInBrowser(playbackForComment) {
    //the platform dependent command to start the browser
    let command;

    //if it is a mac
    if(process.platform === 'darwin') {
        command = 'open';
    } else if(process.platform === 'win32') { //windows
        command = 'explorer.exe';
    } else if(process.platform === 'linux') { //linux
        command = 'xdg-open';
    } else { //some other exotic platform
        console.log(`Unsupported platform: ${process.platform}`);
    }

    //if there was a valid platform
    if(command) {
        //if the user wants to add a comment with this playback
        if(playbackForComment) {
            //now start the browser with the URL of the latest playback
            spawn(command, ['http://localhost:53140/playback.html?comment=true']);
        } else { //no comment, just a regular playback
            //now start the browser with the URL of the latest playback
            spawn(command, ['http://localhost:53140/playback.html']);
        }
    }
}
/*
 * Prompt the user and tell them about how to start using Storyteller.
 */
function promptInformingAboutUsingStoryteller(warnAboutOpeningAProject) {
    //notify the user that they can use storyteller
    let message = 'You can use Storyteller by selecting \'Storyteller: Start Tracking This Project\' from the command palette or clicking the \'Start Storyteller\' button below. ';

    if(warnAboutOpeningAProject) {
        message = 'You must open a folder to use Storyteller. ' + message;
    }

    //show the message
    vscode.window.showInformationMessage(message);
}
/*
 * Get some info about the storyteller project.
 */
function storytellerState() {
    //if storyteller is active
    if(isStorytellerCurrentlyActive) {
        try {
            //get the active developer group devs
            const activeDevs = projectManager.developerManager.getActiveDevelopers();

            //create a friendly string of dev info (user name <email>)
            const devStrings = activeDevs.map(dev => `${dev.userName} <${dev.email}>`);

            //display the working dir and the active devs
            const msg = `Storyteller is active in ${vscode.workspace.workspaceFolders[0].uri.fsPath}. The active developers are: ${devStrings.join(', ')}`;
            vscode.window.showInformationMessage(msg);  
        } catch(ex) {
            console.log('Error in storytellerState()');
        }
    } else { //storyteller not active
        //tell the user how they can use storyteller
        promptInformingAboutUsingStoryteller(true);
    }
}
/********************************* Developer *********************************/
/*
 * Display the currently active developers.
 */
function currentActiveDevelopers() {
    if(isStorytellerCurrentlyActive) {
        try {
            //get the active developer group devs
            const activeDevs = projectManager.developerManager.getActiveDevelopers();

            //create a friendly string of dev info (user name <email>)
            const devStrings = activeDevs.map(dev => `${dev.userName} <${dev.email}>`);

            //create a message with the dev info
            const msg = `The active developers are: ${devStrings.join(', ')}`;
            vscode.window.showInformationMessage(msg);
        } catch(ex) {
            console.log('Error in currentActiveDevelopers()');
        }
    } else { //storyteller not active
        //tell the user how they can use storyteller
        promptInformingAboutUsingStoryteller(true);
    }
}
/*
 * Prompt for a new developer and store it.
 */
async function createNewDeveloper() {
    if(isStorytellerCurrentlyActive) {
        try {
            //prompt for the dev info
            let devInfoString = await vscode.window.showInputBox({prompt: 'Enter in a single developer\'s info like this: Grace Hopper grace@mail.com'})

            //if there is anything in the string
            if(devInfoString) {
                //a dev's required info in an object
                const developerInfoObject = {
                    userName: '',
                    email: ''
                };
                //parse the dev info
                getDevInfo(devInfoString, developerInfoObject);
    
                const newDev = projectManager.developerManager.createNewDeveloper(developerInfoObject.userName, developerInfoObject.email);
                projectManager.developerManager.addDevelopersToActiveGroup([newDev.id]);
    
                //give the user some feedback about the active devs
                const activeDevs = projectManager.developerManager.getActiveDevelopers(); 

                //create a friendly string of dev info (user name <email>)
                const devStrings = activeDevs.map(dev => `${dev.userName} <${dev.email}>`);
    
                //create a message with the dev info
                const msg = `The active developers are: ${devStrings.join(', ')}`;
                vscode.window.showInformationMessage(msg);
            } else { //they changed their minds and didn't want to add a new dev
                //show the active devs
                currentActiveDevelopers();
            }
        } catch(ex) {
            //show error message
            vscode.window.showErrorMessage(`Error adding a developer. ${ex}`);
        }
    } else { //storyteller not active
        //tell the user how they can use storyteller
        promptInformingAboutUsingStoryteller(true);
    }
}
/*
 * Display the developers who can be activated and let the user choose one to make active.
 */
async function addDevelopersToActiveGroup() {
    if(isStorytellerCurrentlyActive) {
        try {
            //request the inactive devs
            const inactiveDevs = projectManager.developerManager.getInactiveDevelopers();

            //if there are any inactive devs
            if(inactiveDevs.length > 0) {
                //create a friendly string of dev info (user name <email>)
                const inactiveDevStrings = inactiveDevs.map(dev => `${dev.userName} <${dev.email}>`);
    
                //request the active developer group devs
                const activeDevs = projectManager.developerManager.getActiveDevelopers();

                //create a friendly string of dev info (user name <email>)
                const activeDevStrings = activeDevs.map(dev => `${dev.userName} <${dev.email}>`);
    
                //make a list of inactive devs to choose from
                const selectedOption = await vscode.window.showQuickPick(inactiveDevStrings, {placeHolder: `Choose a developer to add to the active developer group. Currently active: ${activeDevStrings.join(', ')}`})

                //if there was a dev selected
                if(selectedOption) {
                    //find the email portion of the dev
                    const startOfEmail = selectedOption.indexOf('<');
                    const endOfEmail = selectedOption.indexOf('>');

                    //if the email was found
                    if(startOfEmail >= 0 && endOfEmail >= 0) {
                        //extract the user name
                        const userName = selectedOption.substr(0, startOfEmail - 1);

                        //add to an array of devs to add (the function to make 
                        //devs active takes an array even though with this UI 
                        //we can only select one at a time)
                        const userNames = [userName];

                        //add the devs to the active group
                        projectManager.developerManager.addDevelopersToActiveGroupByUserName(userNames);
            
                        //get the active developer group devs
                        const activeDevs = projectManager.developerManager.getActiveDevelopers();
                        //create a friendly string of dev info (user name <email>)
                        const activeDevStrings = activeDevs.map(dev => `${dev.userName} <${dev.email}>`);
            
                        //success message
                        const msg = `${selectedOption} was successfully added to the active developer group. The new active developer group is ${activeDevStrings.join(', ')}`;
                        vscode.window.showInformationMessage(msg);
                    }
                } else {
                    //show the message
                    vscode.window.showErrorMessage('No developer was chosen');
                }
            } else {
                //show the message
                vscode.window.showErrorMessage('There are no inactive developers to add');
            }
        } catch(ex) {
            console.log('Error on adding dev to active dev group');
        }
    } else { //storyteller not active
        //tell the user how they can use storyteller
        promptInformingAboutUsingStoryteller(true);
    }
}
/*
 *  Display the active developers and let the user choose one to make inactive.
 */
async function removeDevelopersFromActiveGroup() {
    if(isStorytellerCurrentlyActive) {
        try {
            //request the active developer group devs
            const activeDevs = projectManager.developerManager.getActiveDevelopers();

            //create a friendly string of dev info (user name <email>)
            const activeDevStrings = activeDevs.map(dev => `${dev.userName} <${dev.email}>`);

            //if there are at least two developers (with room to remove one)
            if(activeDevs.length > 1) {
                //make a list of active devs to choose from
                const selectedOption = await vscode.window.showQuickPick(activeDevStrings, {placeHolder: 'Choose a developer to remove from the active developer group'});

                //if there was a dev selected
                if(selectedOption) {
                    //find the email portion of the dev
                    const startOfEmail = selectedOption.indexOf('<');
                    const endOfEmail = selectedOption.indexOf('>');

                    //if the email was found
                    if(startOfEmail >= 0 && endOfEmail >= 0) {
                        //extract the userName
                        const userName = selectedOption.substr(0, startOfEmail - 1);
            
                        //add to an array of devs to remove (the function to 
                        //make devs inactive takes an array even though with 
                        //this UI we can only select one at a time)
                        const userNames = [userName];

                        //remove the developers
                        projectManager.developerManager.removeDevelopersFromActiveGroupByUserName(userNames);
            
                        //get the active developer group devs
                        const activeDevs = projectManager.developerManager.getActiveDevelopers();

                        //create a friendly string of dev info (user name <email>)
                        const activeDevStrings = activeDevs.map(dev => `${dev.userName} <${dev.email}>`);
            
                        //success message
                        const msg = `${selectedOption} was successfully removed from the active developer group. The new active developer group is ${activeDevStrings.join(', ')}`;
                        vscode.window.showInformationMessage(msg);
                    }
                } else {
                    //show the message
                    vscode.window.showErrorMessage('No developer was chosen');
                }
            } else {
                //show the message
                vscode.window.showErrorMessage('Cannot remove from a dev group with one developer');
            }
        } catch(ex) {
            console.log('Error on removing a dev from an active dev group');
        }
    } else { //storyteller not active
        //tell the user how they can use storyteller
        promptInformingAboutUsingStoryteller(true);
    }
}
/*
 * Prompt for the first developer and overwrite the anonymous developer.
 */
async function createFirstDeveloper() {
    if(isStorytellerCurrentlyActive) {
        try {
            //prompt for the dev info
            let devInfoString = await vscode.window.showInputBox({prompt: 'Enter in a single developer\'s info like this: Grace Hopper grace@mail.com'})

            //if there is anything in the string
            if(devInfoString) {
                //a dev's required info in an object
                const developerInfoObject = {
                    userName: '',
                    email: ''
                };
                //parse the dev info
                getDevInfo(devInfoString, developerInfoObject);
    
                //projectManager.developerManager.addDevelopersToActiveGroup([developerInfoObject]);
                projectManager.developerManager.replaceAnonymousDeveloperWithNewDeveloper(developerInfoObject.userName, developerInfoObject.email);
    
                //give the user some feedback about the active devs
                currentActiveDevelopers();
            } //else- they want to remain anonymous
        } catch(ex) {
            //show error message
            vscode.window.showErrorMessage(`Error adding a developer. ${ex}`);
        }
    } else { //storyteller not active
        //tell the user how they can use storyteller
        promptInformingAboutUsingStoryteller(true);
    }
}
/*
 * Add parse a string for dev info.
 */
function getDevInfo(devInfoString, devInfoObject) {
    //get rid of any space around the info
    devInfoString = devInfoString.trim();

    //if there is anything left after the trim
    if(devInfoString !== '') {
        //split the string around interior spaces
        const devInfoParts = devInfoString.split(/\s+/);
        
        //if there is more than one part
        if(devInfoParts.length > 0) {
            //the last part should be the email
            const possibleEmail = devInfoParts[devInfoParts.length - 1];

            //if the last part looks like an email address
            if(possibleEmail.includes('@') && possibleEmail.includes('.')) {
                devInfoObject.email = possibleEmail;
                devInfoParts.pop();
                devInfoObject.userName = devInfoParts.join(' ');
            } else { //identifying email addresses are required
                throw 'All developers must supply an identifying email address';
            }
        }
    }
    //else- no change to the dev info object
}
//****************************** File/Dir Changes ****************************** 
/*
 * This function is called whenever a new file/dir has been noticed by vs code's 
 * file watcher interface. 
 * 
 * A create event might be because:
 * -- a new file/dir is created
 * -- a file/dir was moved (create event followed by a delete event)
 * -- a file/dir was renamed (create event followed by a delete event)
 * 
 * If the latter two happen (create event followed by a delete event) then this
 * is not really a new file/dir. It is either a move or rename. We record that 
 * the file/dir was created and then check if the file/dir is still present 
 * after a short period of time. 
 * 
 * addRecentCreate() and addRecentDelete() are called in succession for file/dir 
 * renames and moves. After a create is recognized it is assumed that the delete 
 * function will be called soon after. The anonymous function checks to see if the 
 * file/dir path is still present (indicating a true new file/dir).
 */
function addRecentCreate(createEvent) {
    if(isStorytellerCurrentlyActive) {
        //get the path of the newly created file/dir
        const fileDirPath = createEvent.fsPath;

        //path to hidden storyteller dir, .storyteller
        const storytellerPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.storyteller');

        //if the path of the new file/dir is outside the hidden .storyteller dir 
        if(fileDirPath.startsWith(storytellerPath) === false) {
            //add the path to an array to see if it will be removed by a delete 
            recentlyCreatedFileOrDir.push(fileDirPath);

            //in the future, check to see if the path is still in the array. 
            //Give addRecentDelete() a chance to run and remove the path. If it
            //is still present, it is a new file/dir
            setTimeout(function () {
                //look for the entry with the new path
                const index = recentlyCreatedFileOrDir.indexOf(fileDirPath);
    
                //if the path is still in the array of recently added items then this is a true create
                //new file/dir event not a move or rename
                if(index >= 0) {
                    //determine if the new path is to a file or directory
                    const stats = fs.statSync(fileDirPath);

                    //if it is a file
                    if(stats.isFile()) {
                        projectManager.createFile(fileDirPath);
                    } else if(stats.isDirectory()) { //it is a dir 
                        projectManager.createDirectory(fileDirPath);
                    }
                    //remove the path since we have handled it
                    const removedPath = recentlyCreatedFileOrDir.splice(index, 1);
                    //console.log(`Removed ${removedPath} from recentlyCreatedFileOrDir new size is ${recentlyCreatedFileOrDir.length}`);
                } else { 
                    //if the path is gone it is because the create event was followed by a delete 
                    //event (a move or rename) that was handled in the delete function
                    //console.log(`The file: ${fileDirPath} is not present in recentlyCreatedFileOrDir- it was moved/renamed`);
                }
            }, waitForDeleteEventTimeout);
        } //else- this is a change in the hidden .storyteller dir that is ignored by the tool
    }
}
/*
 * This function is called whenever vs code notices that a file/dir has been 
 * deleted.
 *
 * delete event might be because:
 * -- a file/dir was deleted
 * -- a file/dir was moved (create event followed by a delete event)
 * -- a file/dir was renamed (create event followed by a delete event)
 * 
 * If the latter two happen (create event followed by a delete event) then this 
 * is not really a file/dir delete. It is either a move or rename. 
 * 
 * addRecentCreate() and addRecentDelete() are called in succession for file/dir 
 * renames and moves. After a create is recognized it is assumed that the delete 
 * function will be called soon after. This function checks to see if the delete 
 * was from a file that was just added in addRecentCreate() (indicating a 
 * rename/move). If there are no paths that were added very recently we assume 
 * it is a real delete. 
 */
function addRecentDelete(deleteEvent) {
    if(isStorytellerCurrentlyActive) {
        //get the path of the deleted file/dir
        const fileDirPath = deleteEvent.fsPath;

        //path to storyteller hidden dir
        const storytellerPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.storyteller');

        //if the path of the new file/dir is not in the hidden .storyteller dir 
        if(fileDirPath.startsWith(storytellerPath) === false) {
            //if there are any elements on this array we are going to assume 
            //this delete is part of a move or rename
            if(recentlyCreatedFileOrDir.length > 0) {
                //get the first entry- this is the path that has changed. I am 
                //assuming that with a move the create and delete events are 
                //queued right next to each other and will be handled in 
                //sequence by calling addRecentCreate() immediately followed by 
                //addRecentDelete()
                const newFullPath = recentlyCreatedFileOrDir.shift();

                //parse the path of the old and new file path
                const parsedNewPath = path.parse(newFullPath);
                const parsedOldPath = path.parse(fileDirPath);
    
                //get the name of the file/dir
                const newName = parsedNewPath.base;
                //get the path up to but not including the name
                const fullPathUpToNewName = parsedNewPath.dir;
    
                //get the name of the file/dir
                const oldName = parsedOldPath.base;
                //get the path up to but not including the name
                const fullPathUpToOldName = parsedOldPath.dir;

                //used to determine if the path is to a file or directory
                const stats = fs.statSync(newFullPath);

                //if it is a file
                if(stats.isFile()) {
                    //if the file ends up in the same parent dir AND the name 
                    //is different, then this is a rename
                    if(fullPathUpToNewName === fullPathUpToOldName && newName !== oldName) {
                        projectManager.renameFile(fileDirPath, newFullPath);
                    } else { //file has moved from one parent dir to another
                        projectManager.moveFile(fileDirPath, newFullPath);
                    }
                } else if(stats.isDirectory()) { //it is a dir 
                    //if the dir ends up in the same parent dir AND the name 
                    //is different, then this is a rename
                    if(fullPathUpToNewName === fullPathUpToOldName && newName !== oldName) {
                        projectManager.renameDirectory(fileDirPath, newFullPath);
                    } else { //dir has moved from one parent dir to another
                        projectManager.moveDirectory(fileDirPath, newFullPath);
                    }
                } else { //it is not a file or dir- something is wrong
                    console.log('Rename or move: Not a file or a dir????');
                }
            } else { //this is a true delete, there are no file paths in 
                //the recentlyCreatedFileOrDir array since the deleted file/dir 
                //is gone we can't check to see if it is a file or dir so we 
                //will let storyteller check the type based on the path and 
                //call the correct delete function
                projectManager.deleteFileOrDirectory(fileDirPath);
            }
        }
    }
}
//****************************** Text Editor Changes ****************************** 
/*
 * This function is called whenever code is added or removed from an editor.
 */
function handleTextEditorChange(event) {
    if(isStorytellerCurrentlyActive) {
        //path to the file that is being edited
        const filePath = event.document.fileName;

        //if the file being edited is in the tracked st project
        if(filePath.startsWith(vscode.workspace.workspaceFolders[0].uri.fsPath) === true) {
            //go through each of the changes in this change event (there can 
            //be more than one if there are multiple cursors)
            for(let i = 0;i < event.contentChanges.length;i++) {
                //get the change object
                const change = event.contentChanges[i];
    
                //if no text has been added, then this is a delete
                if(change.text.length === 0) {
                    //get some data about the delete
                    const numCharactersDeleted = change.rangeLength;
                    const deleteTextStartLine = change.range.start.line;
                    const deleteTextStartColumn = change.range.start.character;
        
                    //record the deletion of text
                    projectManager.handleDeletedText(filePath, deleteTextStartLine, deleteTextStartColumn, numCharactersDeleted);
                } else { //new text has been added in this change, this is an insert
                    //if there was some text that was selected and replaced 
                    //(deleted and then added)
                    if(change.rangeLength > 0) {
                        //get some data about the delete
                        const numCharactersDeleted = change.rangeLength;
                        const deleteTextStartLine = change.range.start.line;
                        const deleteTextStartColumn = change.range.start.character;

                        //first delete the selected code (insert of new text to follow)
                        projectManager.handleDeletedText(filePath, deleteTextStartLine, deleteTextStartColumn, numCharactersDeleted);
                    } 
        
                    //get some data about the insert
                    const newText = change.text;
                    const newTextStartLine = change.range.start.line;
                    const newTextStartColumn = change.range.start.character;
        
                    //a set of all the event ids from a copy/cut
                    let pastedInsertEventIds = [];

                    //if this was a paste
                    if(clipboardData.activePaste) { 
                        //if the new text is exactly the same as what was on our clipboard
                        if(newText === clipboardData.text) {
                            //store the pasted event ids
                            pastedInsertEventIds = clipboardData.eventIds;
                        } else { //this is a paste but it doesn't match the last storyteller copy/cut (pasted from another source)
                            //create an array of strings with 'other' for the paste event ids to signify a paste from outside the editor
                            pastedInsertEventIds = newText.split('').map(() => 'other');

                            //clear out any old data
                            clipboardData.text = '';
                            clipboardData.eventIds = [];
                        }

                        //we handled the most current paste, set this back to false
                        clipboardData.activePaste = false;
                    }
                    //record the insertion of new text
                    projectManager.handleInsertedText(filePath, newText, newTextStartLine, newTextStartColumn, pastedInsertEventIds);
                }
            }
        }
    }
}
/*
 * This function is called whenever code is saved.
 */
function handleFileSave() {
    if(isStorytellerCurrentlyActive) {
        //a file save happened, let the project manager know
        projectManager.saveTextFileState();
    }
}

/*
 * Function that overrides the default copy behavior. We get the selection and
 * use it, dispose of this registered command (returning to the default 
 * editor.action.clipboardCopyAction), invoke
 */
function overriddenClipboardCopyAction(textEditor, edit, params) {
    //use the selected text that is being copied here
    getCurrentSelectionEvents();

    //dispose of the overridden editor.action.clipboardCopyAction- back to default copy behavior
    clipboardCopyDisposable.dispose();

    //execute the default editor.action.clipboardCopyAction to copy
    vscode.commands.executeCommand("editor.action.clipboardCopyAction").then(function(){
        //console.log("After Copy");

        //add the overridden editor.action.clipboardCopyAction back
        clipboardCopyDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardCopyAction', overriddenClipboardCopyAction);
        //context.subscriptions.push(clipboardCopyDisposable);
    }); 
}

/*
 * Function that overrides the default cut behavior. We get the selection and 
 * use it, dispose of this registered command (returning to the default 
 * editor.action.clipboardCutAction), invoke
 */
function overriddenClipboardCutAction(textEditor, edit, params) {
    //use the selected text that is being cut here
    getCurrentSelectionEvents();

    //dispose of the overridden editor.action.clipboardCutAction- back to default cut behavior
    clipboardCutDisposable.dispose();

    //execute the default editor.action.clipboardCutAction to cut
    vscode.commands.executeCommand("editor.action.clipboardCutAction").then(function(){
        //console.log("After Cut");

        //add the overridden editor.action.clipboardCutAction back
        clipboardCutDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardCutAction', overriddenClipboardCutAction);
        //context.subscriptions.push(clipboardCutDisposable);
    }); 
}

/*
 * Function that overrides the default paste behavior. We get the selection and 
 * use it, dispose of this registered command (returning to the default 
 * editor.action.clipboardPasteAction), invoke
 */
function overriddenClipboardPasteAction(textEditor, edit, params) {
    //use the selected text that is being copied here
    //indicate that there was a paste operation
    clipboardData.activePaste = true;

    //dispose of the overridden editor.action.clipboardPasteAction- back to default paste behavior
    clipboardPasteDisposable.dispose();

    //execute the default editor.action.clipboardPasteAction to paste
    vscode.commands.executeCommand("editor.action.clipboardPasteAction").then(function(){
        //console.log("After Paste");

        //add the overridden editor.action.clipboardPasteAction back
        clipboardPasteDisposable = vscode.commands.registerTextEditorCommand('editor.action.clipboardPasteAction', overriddenClipboardPasteAction);
        //context.subscriptions.push(clipboardPasteDisposable);
    }); 
}
/*
 * This function gets any selected text in the current open editor and then 
 * copies the data about the insert events that will get placed on the 
 * clipboard.
 */
function getCurrentSelectionEvents() {
    //get the active editor
    const editor = vscode.window.activeTextEditor;

    //if there is an active text editor
    if(editor) {
        //get the editor selection (we only handle a single selection)
        const selection = editor.selection;

        //if there is a selection
        if(!selection.isEmpty) {
            //if there are some selected characters in the selection
            if(!selection.start.isEqual(selection.end)) {
                //name of the file where the copy occured and strip the leading part of the path 
                const filePath = projectManager.pathHelper.normalizeFilePath(editor.document.fileName);
                const file = projectManager.fileSystemManager.getFileInfoFromFilePath(filePath);
                //get the storyteller events associated with the selected text
                const selectedEvents = file.getInsertEventsByPos(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
                
                //clear out any old data
                clipboardData.text = "";
                clipboardData.eventIds = [];

                //go through the selected events
                for(let j = 0;j < selectedEvents.length;j++) {
                    //append the individual selected characters to the clipboard data
                    clipboardData.text = clipboardData.text + selectedEvents[j].character;
                    
                    //add the event id to the clipboard data
                    clipboardData.eventIds.push(selectedEvents[j].id);
                }
            }
        }
    }
}
/*
 * Used to create a zip file of a project. These can be shared with others
 * who have the extension installed.
 */
async function zipProject() {
    //if st is active
    if(isStorytellerCurrentlyActive) {
        //prompt for where to store the zip file
        let zipStorageFolders = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: vscode.workspace.workspaceFolders[0].uri,
            openLabel: 'Save st.zip',
            title: 'Choose a folder to store the Storyteller zip'
        });

        //if there was a selected location
        if(zipStorageFolders.length > 0) {
            //create an instance of jszip
            const zip = new JSZip();

            //get the path to the open project and the hidden st directory
            const projectDirPath = vscode.workspace.workspaceFolders[0].uri.fsPath;

            //recursively add files to the zip
            zipProjectHelper(projectDirPath, zip);

            //create and save the zip in the .storyteller dir
            zip.generateNodeStream({
                streamFiles: true,
                compression: 'DEFLATE',
                compressionOptions: {
                    level: 9
                }
            }).pipe(fs.createWriteStream(path.join(zipStorageFolders[0].fsPath, 'st.zip'))).on('finish', function () {
                //notify user that the zip is complete
                vscode.window.showInformationMessage(`A new zip file, st.zip, has been added to the ${zipStorageFolders[0].fsPath} directory. You can share this file with others.`);
            });
        }
    }
}
/*
 * Helper that recursively moves through the file system
 */
function zipProjectHelper(dirPath, zip) {
    //get all of the files and dirs in the passed in directory
    const allFilesAndDirs = fs.readdirSync(dirPath);

    //go through the contents of the dir
    for (let i = 0; i < allFilesAndDirs.length; i++) {
        //get the full path to the file or directory
        const fullPathToFileOrDir = path.join(dirPath, allFilesAndDirs[i]);

        //get some stats about the file/dir
        const stats = fs.statSync(fullPathToFileOrDir);

        //if this is a file
        if(stats.isFile()) {
            //get a normalized path to the file
            let normalizedFilePath = projectManager.pathHelper.normalizeFilePath(fullPathToFileOrDir);
            //jszip does not like leading / so remove it
            normalizedFilePath = normalizedFilePath.substr(1);

            //read the contents of the file
            const fileContents = fs.readFileSync(fullPathToFileOrDir, 'utf8');
            
            //add the file to the zip
            zip.file(normalizedFilePath, fileContents);
        } else if(stats.isDirectory()) {
            //get a normalized path to the dir
            let normalizedDirectoryPath = projectManager.pathHelper.normalizeDirPath(fullPathToFileOrDir);
            //jszip does not like leading / so remove it
            normalizedDirectoryPath = normalizedDirectoryPath.substr(1);
            //add the folder to the zip (for empty dirs)
            zip.folder(normalizedDirectoryPath);

            //recurse and add the files in the dir to the zip
            zipProjectHelper(fullPathToFileOrDir, zip);
        }
    }
}

module.exports = {
    activate,
    deactivate
}