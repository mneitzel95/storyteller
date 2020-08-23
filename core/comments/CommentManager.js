const Comment  = require('./Comment.js');
const FileBackedCollection = require('../FileBackedCollection.js');
const path = require('path');
const fs = require('fs');

/*
 * This class manages the comments in the system. There is an object that uses
 * event ids as the key and arrays of comments as the value. During playback
 * when an event is animated this object is checked to see if there are any
 * comments, and if so, they are displayed.
 */
class CommentManager extends FileBackedCollection {
    constructor(storytellerDirPath) {
        //init the base class
        super(storytellerDirPath, 'comments', 'comments.json');

        //create full paths to the media directories
        this.pathToMediaDir = path.join(this.fullPathToParentDir, 'media');
        this.pathToImagesDir = path.join(this.fullPathToParentDir, 'media', 'images');
        this.pathToVideosDir = path.join(this.fullPathToParentDir, 'media', 'videos');
        this.pathToAudiosDir = path.join(this.fullPathToParentDir, 'media', 'audios');
        this.pathToTempDir = path.join(this.fullPathToParentDir, 'media', '.tmp');

        //create web paths to the media directories to return relative urls of media
        this.webPathToImagesDir = path.posix.join('media', 'images');
        this.webPathToVideosDir = path.posix.join('media', 'videos');
        this.webPathToAudiosDir = path.posix.join('media', 'audios');

        //if the json file exists
        if(this.fileExists()) {
            //read the data from the file and load the comment info
            this.read();
        } else { //no json file exists
            //make the media directory with subdirs for images, videos, and audio files
            fs.mkdirSync(this.pathToMediaDir, {recursive: true});
            fs.mkdirSync(this.pathToImagesDir, {recursive: true});
            fs.mkdirSync(this.pathToVideosDir, {recursive: true});
            fs.mkdirSync(this.pathToAudiosDir, {recursive: true});
            fs.mkdirSync(this.pathToTempDir, {recursive: true});

            //init an object to hold comments
            this.comments = {};
            this.write();
        }
    }

    write() {
        //pass in an object to be written to a json file
        super.write({
            comments: this.comments,
            commentAutoGeneratedId: Comment.nextId
        });
    }

    read() {
        //read the data from the file
        const anObject = super.read();

        //set the auto-generated ids for the comments
        Comment.nextId = anObject.commentAutoGeneratedId;
        
        //store the comments data
        this.comments = anObject.comments;

        //go through and make all of the objects true Comment objects
        for(let eventId in this.comments) {
            //a new array to hold the Comment objects for an event
            const allCommentsForAnEvent = [];

            //go through all of the raw comment objects
            for(let i = 0;i < this.comments[eventId].length;i++) {
                //get the raw comment data
                const comment = this.comments[eventId][i];
                //create the Comment object and add it to the array
                allCommentsForAnEvent.push(new Comment(comment.displayCommentEvent, comment.developerGroupId, comment.timestamp, comment.commentText, comment.selectedCodeBlocks, comment.imageURLs, comment.videoURLs, comment.audioURLs, comment.id));
            }

            //replace the raw object array with one filled with Comments
            this.comments[eventId] = allCommentsForAnEvent;
        }
    }

    /*
     * Adds a comment to the collection of all comments.
     */
    addComment(commentData) {
        //create a comment object
        const newComment = new Comment(commentData.displayCommentEvent, commentData.developerGroupId, commentData.timestamp, commentData.commentText, commentData.selectedCodeBlocks, commentData.imageURLs, commentData.videoURLs, commentData.audioURLs);
        
        //if an array of comments does not already exist for this event
        if(!this.comments[commentData.displayCommentEvent.id]) {
            //create an empty array to hold the comments for this event
            this.comments[commentData.displayCommentEvent.id] = [];
        } 
        //store the comment in the array
        this.comments[commentData.displayCommentEvent.id].push(newComment);

        //update the data
        this.write();

        return newComment;
    }

    /*
     * Update an existing comment.
     */
    updateComment(commentData) {
        //if the array of comments exists for the specified event 
        if(this.comments[commentData.displayCommentEvent.id]) {
            //get the array of comments for the event
            const allCommentsForAnEvent = this.comments[commentData.displayCommentEvent.id];

            //search for the correct comment
            for(let i = 0;i < allCommentsForAnEvent.length;i++) {
                //find the correct comment based on its id
                if(allCommentsForAnEvent[i].id === commentData.id) {
                    //create an updated comment object
                    const updatedComment = new Comment(commentData.displayCommentEvent, commentData.developerGroupId, commentData.timestamp, commentData.commentText, commentData.selectedCodeBlocks, commentData.imageURLs, commentData.videoURLs, commentData.audioURLs, commentData.id);
                    //update the comment
                    allCommentsForAnEvent[i] = updatedComment;

                    //update the data
                    this.write();

                    return updatedComment;
                }
            }
        }
    }

    /*
     * Deletes a comment.
     */
    deleteComment(commentData) {
        //get the array of events at the event id
        const arrayOfCommentsAtThisEvent = this.comments[commentData.displayCommentEvent.id];
        
        //if there is an array for the event id
        if(arrayOfCommentsAtThisEvent) {
            let indexOfComment = -1;
            //go through all of the events at this event
            for(let i = 0;i < arrayOfCommentsAtThisEvent.length;i++) {
                //if the two comments have the same id
                if(arrayOfCommentsAtThisEvent[i].id === commentData.id) {
                    //record the position of the comment to remove
                    indexOfComment = i;
                    break;
                }
            }

            //if the comment was found
            if(indexOfComment >= 0) {
                //remove the comment
                arrayOfCommentsAtThisEvent.splice(indexOfComment, 1);

                //if there are no more comments at this event
                if(arrayOfCommentsAtThisEvent.length === 0) {
                    //remove the array of comments for this event
                    delete this.comments[commentData.displayCommentEvent.id];
                }

                //update the data
                this.write();
            }
        }
    }

    /*
     * Updates the position of a comment in the array of comments.
     */
    updateCommentPosition(updatedCommentPosition) {
        //get the array of comment at the event id
        const arrayOfCommentsAtThisEvent = this.comments[updatedCommentPosition.eventId];
        
        //if the list of comments exists for the specified event 
        if(arrayOfCommentsAtThisEvent) {
            //if the array of comments is present and the old and new positions are valid
            if(updatedCommentPosition.oldCommentPosition >= 0 &&
               updatedCommentPosition.oldCommentPosition < arrayOfCommentsAtThisEvent.length &&
               updatedCommentPosition.newCommentPosition >= 0 &&
               updatedCommentPosition.newCommentPosition < arrayOfCommentsAtThisEvent.length) {
                //get the element to move
                const element = arrayOfCommentsAtThisEvent[updatedCommentPosition.oldCommentPosition];

                //remove it from the array
                arrayOfCommentsAtThisEvent.splice(updatedCommentPosition.oldCommentPosition, 1);

                //add it back in the new postion
                arrayOfCommentsAtThisEvent.splice(updatedCommentPosition.newCommentPosition, 0, element);

                //update the data
                this.write();
            }
        }
    }
}

module.exports = CommentManager;