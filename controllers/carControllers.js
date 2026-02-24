import Car from "../models/carModel.js";
import path from "path";
import fs from "fs";
import cloudinary from "../config/cloudinary.js";

const getPublicIdFromUrl = (url) => {
  try {
    const p = new URL(url).pathname; // e.g. /<cloud>/image/upload/v1234/folder/name.jpg
    const parts = p.split('/upload/');
    if (parts.length < 2) return null;
    let after = parts[1];
    after = after.replace(/^v\d+\//, '');
    const lastDot = after.lastIndexOf('.');
    if (lastDot !== -1) after = after.slice(0, lastDot);
    return after;
  } catch (err) {
    return null;
  }
};

export const createCar = async (req, res, next) => {
  try {
    const {
      make,
      model,
      dailyRate,
      category,
      description,
      year,
      color,
      seats,
      transmission,
      fuelType,
      mileage,
      status,
    } = req.body;

    if (!make || !model || !dailyRate) {
      return res
        .status(400)
        .json({ message: "Make, model, and daily rate are required." });
    }

    let imageFilename = req.body.image || "";
    let imagePublicId = req.body.imagePublicId || "";
    if (req.file) {
      imageFilename = req.file.path || req.file.secure_url || req.file.url || req.file.filename || "";
      imagePublicId = req.file.filename || imagePublicId || getPublicIdFromUrl(imageFilename) || "";
    }

    const car = new Car({
      make,
      model,
      year: year ? Number(year) : undefined,
      color: color || "",
      category: category || "Sedan",
      seats: seats ? Number(seats) : 4,
      transmission: transmission || "Automatic",
      fuelType: fuelType || "Gasoline",
      mileage: mileage ? Number(mileage) : 0,
      dailyRate: Number(dailyRate),
      status: status || "available",
      image: imageFilename || "",
      imagePublicId: imagePublicId || "",
      description: description || "",
    });

    const saved = await car.save();
    res.status(201).json(saved);
  } catch (error) {
    next(error);
  }
};

export const getCars = async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 12;
    const search = req.query.search || "";
    const category = req.query.category || "";
    const status = req.query.status || "";

    const query = {};
    if (search) {
      query.$or = [
        { make: { $regex: search, $options: "i" } },
        { model: { $regex: search, $options: "i" } },
        { color: { $regex: search, $options: "i" } },
      ];
    }
    if (category) {
      query.category = category;
    }
    if (status) query.status = status;

    const total = await Car.countDocuments(query);
    const cars = await Car.find(query)
      .skip((page - 1) * limit)
      .limit(limit)
      .sort({ createdAt: -1 });

      const carsWithAvailability = cars.map(c => {
        const plain = c.toObject ? c.toObject() : c;
        plain.availability = c.getAvailabilitySummary();
        return plain;
      });
      
    res.status(200).json({
     page,
     pages: Math.ceil(total / limit),
     total,
     data: carsWithAvailability,
    });


  } catch (error) {
    next(error);
  }
};

export const getCarById = async (req, res, next) => {
    try {
        const car = await Car.findById(req.params.id);
        if (!car) {
            return res.status(404).json({ message: "Car not found" });
        }
        const plain = car.toObject();
        plain.availability = car.getAvailabilitySummary();
        res.status(200).json(plain);


    } catch (error) {
     next(error);   
    }
 }

 export const updateCar = async (req, res, next) => { 
    try {
        const car = await Car.findById(req.params.id);
        if (!car) {
            return res.status(404).json({ message: "Car not found" });
        }
        if (req.file) {
          if (car.imagePublicId) {
            await cloudinary.uploader.destroy(car.imagePublicId).catch(err => console.error('Cloudinary delete error:', err));
          } else if (car.image && typeof car.image === 'string' && car.image.startsWith('http')) {
            const publicId = getPublicIdFromUrl(car.image);
            if (publicId) await cloudinary.uploader.destroy(publicId).catch(err => console.error('Cloudinary delete error:', err));
          } else if (car.image) {
            const oldPath = path.join(process.cwd(), "uploads", car.image);
            fs.unlink(oldPath, (err)=> { if (err) console.error("Error deleting old image:", err); })
          }

          car.image = req.file.path || req.file.secure_url || req.file.url || req.file.filename || "";
          car.imagePublicId = req.file.filename || getPublicIdFromUrl(car.image) || "";
        }
        else if (req.body.image !== undefined) { 
               if(!req.body.image && car.image) { 
                if (car.imagePublicId) {
                  await cloudinary.uploader.destroy(car.imagePublicId).catch(err => console.error('Cloudinary delete error:', err));
                } else if (typeof car.image === 'string' && car.image.startsWith('http')) {
                  const publicId = getPublicIdFromUrl(car.image);
                  if (publicId) await cloudinary.uploader.destroy(publicId).catch(err => console.error('Cloudinary delete error:', err));
                } else {
                  const oldPath = path.join(process.cwd(), "uploads", car.image);
                  fs.unlink(oldPath, (err)=> {
                    if (err) console.error("Error deleting old image:", err);
                  })
                }
                car.image = "";
                car.imagePublicId = "";
               }
        }

         const fields = ['make','model','year','color','category','seats','transmission','fuelType','mileage','dailyRate','status','description'];

         fields.forEach(field => {
             if (req.body[field] !== undefined) {
                if( ['year','seats','mileage','dailyRate'].includes(field)) {
                    car[field] = Number(req.body[field]);
                } else {
                    car[field] = req.body[field];
                }
             }
         });

         const updatedCar = await car.save();
         res.status(200).json(updatedCar);
        
    } catch (error) {
        next(error);
    }
 }

 export const deleteCar = async (req, res, next) => { 
    try {
        const car = await Car.findById(req.params.id);
        if (!car) {
            return res.status(404).json({ message: "Car not found" });
        }
        if (car.imagePublicId) {
            await cloudinary.uploader.destroy(car.imagePublicId).catch(err => console.error('Cloudinary delete error:', err));
        } else if (car.image && typeof car.image === 'string' && car.image.startsWith('http')) {
            const publicId = getPublicIdFromUrl(car.image);
            if (publicId) {
                await cloudinary.uploader.destroy(publicId).catch(err => console.error('Cloudinary delete error:', err));
            }
        } else if (car.image) {
            const oldPath = path.join(process.cwd(), "uploads", car.image);
            fs.unlink(oldPath, (err)=> { if (err) console.error("Error deleting image:", err); })
        }

        await Car.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: "Car deleted successfully" });
    } catch (error) {
        next(error);
    }
 }
