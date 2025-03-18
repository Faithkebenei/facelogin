// Import dependencies
import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route, useNavigate } from "react-router-dom";
import { FaArrowRight } from "react-icons/fa6";
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage, ref, uploadString, getDownloadURL, uploadBytes } from 'firebase/storage';
import { collection, where, getDocs, addDoc } from 'firebase/firestore';
import styles from "./Landing.module.scss";
import { query } from "firebase/firestore";
import { FaceClient } from "@azure/cognitiveservices-face";
import { ApiKeyCredentials } from "@azure/ms-rest-js";
import AWS from 'aws-sdk';
import { v4 as uuidv4 } from "uuid";



// Firebase configuration
const firebaseConfig = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
    measurementId: process.env.REACT_APP_FIREBASE_MEASUREMENT_ID
};


// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

const Landing = () => {
    const navigate = useNavigate();
    const videoRef = useRef(null);
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(false);
    const [loginStatus, setLoginStatus] = useState('');
    const [openCamera, setOpenCamera] = useState(false);
    const [latitude, setLatitude] = useState("");
    const [longitude, setLongitude] = useState("");
    const [loginTime, setLoginTime] = useState("");
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [imageURL, setImageURL] = useState("");
    const [imagePath, setImagePath] = useState("");
    const [addUserInfo, setAddUserInfo] = useState(false);
    const [faceImage, setFaceImage] = useState(false);
    const [imageFile, setImageFile] = useState("");

    const canvasRef = useRef(null);


    const s3 = new AWS.S3({
        accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY,
        region: process.env.REACT_APP_AWS_REGION
    });

    const rekognition = new AWS.Rekognition({
        accessKeyId: process.env.REACT_APP_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.REACT_APP_AWS_SECRET_ACCESS_KEY,
        region: process.env.REACT_APP_AWS_REGION
    });



    useEffect(() => {
        startVideo();
    }, []);

    const startVideo = () => {
        navigator.mediaDevices
            .getUserMedia({ video: true })
            .then((stream) => {
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                }
            })
            .catch((err) => console.error("Error accessing camera:", err));
    };

    const captureAndUpload = async () => {
        if (!videoRef.current || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");

        // Capture frame from video
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

        // Convert canvas to Blob
        canvas.toBlob(async (blob) => {
            if (blob) {
                const file = new File([blob], "face.jpg", { type: "image/jpeg" });
                const uploadResult = await uploadToFirebase(file);

                if (uploadResult) {
                    setImageFile(file)
                    setImageURL(uploadResult.downloadURL);
                    setImagePath(uploadResult.filePath);
                }
            }
        }, "image/jpeg");
    };


    const uploadToFirebase = async (file) => {
        try {
            const filePath = `faces/${Date.now()}.jpg`;  // 🔹 Store the file path
            const storageRef = ref(storage, filePath);
            await uploadBytes(storageRef, file);
            const downloadURL = await getDownloadURL(storageRef);

            return { downloadURL, filePath }; // 🔹 Return both values
        } catch (error) {
            console.error("Error uploading file:", error);
            return null;
        }
    };



    // const logLoginActivity = async (email) => {
    //     const location = await new Promise((resolve, reject) => {
    //         navigator.geolocation.getCurrentPosition(
    //             (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
    //             (error) => reject(error)
    //         );
    //     });

    //     await addDoc(collection(db, "logins"), { email, timestamp: new Date(), location });
    // };






    const registerUser = async () => {
        const name = prompt("Enter your name:");
        const email = prompt("Enter your email:");

        if (!name || !email) {
            alert("Please enter all details!");
            return;
        }

        if (!imageFile) {
            alert("Please capture an image first!");
            return;
        }

        // Generate a unique filename for the user image
        const timestamp = Date.now();
        const uniqueFileName = `${timestamp}_${imageFile.name}`;

        // Upload image to AWS S3
        const uploadResult = await uploadImageToS3(imageFile, uniqueFileName);

        if (!uploadResult) {
            alert("Image upload failed!");
            return;
        }

        // Check and create Rekognition Collection if not exists
        const collectionId = "users_faces";
        await checkAndCreateCollection(collectionId);

        // Index face in AWS Rekognition
        const indexResult = await indexFaceInRekognition(uploadResult.imagePath, collectionId);
        if (!indexResult) {
            alert("Face indexing failed in Rekognition!");
            return;
        }

        // Store user details in Firebase
        try {
            await addDoc(collection(db, "users"), {
                name,
                email,
                imageURL: uploadResult.imageURL,
                imagePath: uploadResult.imagePath, // Store the S3 image path
                faceId: indexResult.FaceRecords[0]?.Face?.FaceId || null // Store the Face ID from Rekognition
            });
            alert("User registered successfully!");
        } catch (error) {
            console.error("Error registering user:", error);
        }
    };

    const uploadImageToS3 = async (file, filePath) => {
        const params = {
            Bucket: process.env.REACT_APP_AWS_S3_BUCKET,
            Key: filePath,
            Body: file,
            ACL: "public-read",
            ContentType: file.type
        };

        try {
            const uploadResult = await s3.upload(params).promise();
            return { imageURL: uploadResult.Location, imagePath: filePath };
        } catch (error) {
            console.error("S3 Upload Error:", error);
            return null;
        }
    };


    const checkAndCreateCollection = async (collectionId) => {
        const params = { CollectionId: collectionId };

        try {
            await rekognition.describeCollection(params).promise();
            console.log("Collection already exists.");
        } catch (error) {
            if (error.code === "ResourceNotFoundException") {
                await rekognition.createCollection(params).promise();
                console.log("Collection Created Successfully!");
            } else {
                console.error("Error Checking Collection:", error);
            }
        }
    };


    const indexFaceInRekognition = async (imagePath, collectionId) => {
        const params = {
            CollectionId: collectionId,
            Image: {
                S3Object: {
                    Bucket: process.env.REACT_APP_AWS_S3_BUCKET,
                    Name: imagePath
                }
            },
            ExternalImageId: imagePath, // Use the unique image path as an ID
            DetectionAttributes: ["ALL"]
        };

        try {
            const response = await rekognition.indexFaces(params).promise();
            console.log("Face Indexed:", response);
            return response;
        } catch (error) {
            console.error("AWS Rekognition Indexing Error:", error);
            return null;
        }
    };

    console.log("S3 Bucket:", process.env.REACT_APP_S3_BUCKET);
    console.log("S3 Region:", process.env.REACT_APP_AWS_REGION);



    const loginUser = async () => {
        if (!imageFile) {
            alert("Please capture an image first!");
            return;
        }

        // Upload the captured image to S3 temporarily
        // Generate a unique file name for the login image
        const timestamp = Date.now();
        const filePath = `temp/${timestamp}_face.jpg`; // Store in a temp folder

        // Upload image to AWS S3
        const uploadResult = await uploadImageToS3(imageFile, filePath);
        if (!uploadResult) {
            alert("Image upload failed!");
            return;
        }

        const params = {
            CollectionId: "users_faces", // Replace with your AWS Rekognition collection ID
            Image: {
                S3Object: {
                    Bucket: process.env.REACT_APP_AWS_S3_BUCKET,
                    Name: uploadResult.imagePath // The uploaded image path
                }
            },
            MaxFaces: 1, // Only get the best match
            FaceMatchThreshold: 90 // Set a confidence threshold
        };

        try {
            const rekognitionResponse = await rekognition.searchFacesByImage(params).promise();
            if (rekognitionResponse.FaceMatches.length === 0) {
                alert("No matching face found!");
                await deleteImageFromS3(uploadResult.imagePath); // Delete the uploaded image
                return;
            }

            const bestMatch = rekognitionResponse.FaceMatches[0];
            const matchedImagePath = bestMatch.Face.ExternalImageId;

            console.log("Matched Image Path:", matchedImagePath);

            // Fetch user details from Firebase
            const usersRef = collection(db, "users");
            const querySnapshot = await getDocs(usersRef);

            let matchedUser = null;
            querySnapshot.forEach((doc) => {
                const userData = doc.data();
                if (userData.imagePath === matchedImagePath) {
                    matchedUser = userData;
                }
            });

            if (matchedUser) {
                alert(`Login successful! Welcome, ${matchedUser.name}`);
                console.log("User Details:", matchedUser);

                //Get location
                navigator.geolocation.getCurrentPosition((position) => {
                    setLatitude(position.coords.latitude);
                    setLongitude(position.coords.longitude);
                });

                //Get login time
                //Upload to firebase login logs


            } else {
                alert("Not Recognized");
            }
        } catch (error) {
            console.error("AWS Rekognition Error:", error);
            alert("Face recognition failed!");
        } finally {
            // Ensure the uploaded image is deleted even if an error occurs
            await deleteImageFromS3(uploadResult.imagePath);
        }
    };

    // Function to delete the uploaded image from S3
    const deleteImageFromS3 = async (imagePath) => {
        const params = {
            Bucket: process.env.REACT_APP_AWS_S3_BUCKET,
            Key: imagePath
        };

        try {
            await s3.deleteObject(params).promise();
            console.log("Temporary image deleted from S3:", imagePath);
        } catch (error) {
            console.error("Error deleting image from S3:", error);
        }
    };

    return (
        <div className={styles.landing}>
            <div className={styles.header}>
                <div className={styles.logo}>
                    <div className={styles.image}>
                        <div className={styles.topDots}>
                            <div className={styles.dot} style={{ backgroundColor: "#61DAFB" }}></div>
                            <div className={styles.dot}></div>
                        </div>
                        <div className={styles.bottomDots}>
                            <div className={styles.dot}></div>
                            <div className={styles.dot}></div>
                        </div>
                    </div>
                    <div className={styles.logoText}>
                        <h3>FaceTrack</h3>
                    </div>
                </div>
            </div>

            <div className={styles.body}>
                <Routes>
                    <Route path="/" element={
                        <div className={styles.landingPage}>
                            <div className={styles.image}>
                                <div className={styles.topDots}>
                                    <div className={styles.dot} style={{ backgroundColor: "#61DAFB" }}></div>
                                    <div className={styles.dot}></div>
                                </div>
                                <div className={styles.bottomDots}>
                                    <div className={styles.dot}></div>
                                    <div className={styles.dot}></div>
                                </div>
                            </div>
                            <div className={styles.tagLine}>
                                <h2>
                                    Facial Recognition and Location,<br /> <span>Redefining Secure Logins</span>
                                </h2>
                            </div>
                            <button onClick={() => { navigate("/login"); setOpenCamera(true); }}>
                                Login <FaArrowRight style={{ marginLeft: "10px" }} />
                            </button>
                            <p>Haven't signed up yet? <a href="#" onClick={() => { navigate("/register"); setOpenCamera(true); }}>Register</a></p>
                        </div>
                    } />
                    <Route path="/login" element={
                        <div className={styles.loginPage}>
                            <div className={styles.video}>
                                <video ref={videoRef} autoPlay></video>
                            </div>
                            <canvas ref={canvasRef} width={640} height={480} hidden></canvas>
                            <button onClick={captureAndUpload}>Capture Face</button>

                            <button onClick={loginUser} disabled={!imageURL}>{loading ? 'Processing...' : 'Scan Face'}</button>
                            {user && <p>Welcome, {user.name}!</p>}
                        </div>
                    } />
                    <Route path="/register" element={
                        <div className={styles.loginPage}>
                            <div className={styles.video}>
                                <video ref={videoRef} autoPlay></video>
                            </div>
                            <canvas ref={canvasRef} width={640} height={480} hidden></canvas>
                            <button onClick={captureAndUpload}>Capture Face</button>
                            <button onClick={registerUser} disabled={!imageURL}>Register</button>
                        </div>
                    } />
                </Routes>
            </div>
        </div>
    );
};

export default Landing;

