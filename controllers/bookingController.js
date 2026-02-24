import mongoose from "mongoose";
import Booking from "../models/bookingModel.js";
import Car from "../models/carModel.js";
import path from "path";
import fs from "fs";
import { error } from "console";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const BLOCKING_STATUSES = ["pending", "active", "upcoming"];

const tryParseJSON = (v) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return v;
  }
};

const buildCarSummary = (src = {}) => {
  const id = src._id?.toString?.() || src.id || null;
  
  // Handle case where frontend sends 'name' field instead of separate make/model
  let make = src.make || "";
  let model = src.model || "";
  
  // If we have a name field but no make/model, try to parse it
  if (src.name && !make && !model) {
    const nameParts = src.name.trim().split(' ');
    if (nameParts.length >= 2) {
      make = nameParts[0];
      model = nameParts.slice(1).join(' ');
    } else {
      make = src.name;
    }
  }
  
  return {
    id,
    make,
    model,
    year: src.year ? Number(src.year) : null,
    dailyRate: src.dailyRate ? Number(src.dailyRate) : 0,
    seats: src.seats ? Number(src.seats) : 4,
    transmission: src.transmission,
    fuelType: src.fuelType,
    mileage: src.mileage ? Number(src.mileage) : 0,
    image: src.image || src.carImage || "",
  };
};

const deleteLocalFileIfPresent = (filePath) => {
  if (!filePath) return;
  const filename = filePath.replace(/^\/uploads\//, "");
  const full = path.join(UPLOADS_DIR, filename);
  fs.unlink(full, (error) => {
    if (error) console.warn("Error deleting file", full, error);
    console.log("Deleted file: ", full);
  });
};

export const createBooking = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    let {
      customer,
      email,
      phone,
      car,
      pickupDate,
      returnDate,
      amount,
      details,
      address,
      carImage,
    } = req.body;

    if (!customer || !email || !phone || !car || !pickupDate || !returnDate) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Missing required fields" });
    }

    const pickup = new Date(pickupDate);
    const ret = new Date(returnDate);

    if (
      Number.isNaN(pickup.getTime()) ||
      Number.isNaN(ret.getTime()) ||
      pickup > ret
    ) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ message: "Invalid date format and pickup and return date" });
    }

    // Resolve car summary (accepts ObjectId string, object, or stringified JSON)
    let carSummary = null;
    if (typeof car === "string" && /^[0-9a-fA-F]{24}$/.test(car)) {
      const carDoc = await Car.findById(car).session(session).lean();
      if (!carDoc) {
        await session.abortTransaction();
        session.endSession();
        return res
          .status(404)
          .json({ success: false, message: "Car not found" });
      }
      carSummary = buildCarSummary(carDoc);
    } else {
      const parsed = tryParseJSON(car) || car;
      carSummary = buildCarSummary(parsed);
      if (!carSummary.id) {
        await session.abortTransaction();
        session.endSession();
        return res
          .status(400)
          .json({ success: false, message: "Invalid car payload" });
      }
      const carExists = await Car.exists({ _id: carSummary.id }).session(
        session,
      );
      if (!carExists) {
        await session.abortTransaction();
        session.endSession();
        return res
          .status(404)
          .json({ success: false, message: "Car not found" });
      }
    }

    const carId = carSummary.id;
    const overlappingCount = await Booking.countDocuments({
      "car.id": carId,
      status: { $in: BLOCKING_STATUSES },
      pickupDate: { $lte: ret },
      returnDate: { $gte: pickup },
    }).session(session);

    if (overlappingCount > 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message: "Car is already booked for the selected dates",
      });
    }

    const bookingData = {
      userId: req?.user?.id || req.user?._id || null,
      customer,
      email,
      phone,
      car: carSummary,
      carImage: carImage || carSummary.image || "",
      pickupDate: pickup,
      returnDate: ret,
      amount: Number(amount || 0),
      details: tryParseJSON(details),
      address: tryParseJSON(address),
      paymentStatus: "pending",
      status: "pending",
    };

    const createdArr = await Booking.create([bookingData], { session });
    const createdBooking = createdArr[0];
    const bookingEntry = {
      bookingid: createdBooking._id,
      pickupDate: createdBooking.pickupDate,
      returnDate: createdBooking.returnDate,
      status: createdBooking.status,
    };

    await Car.findByIdAndUpdate(
      carId,
      { $push: { bookings: bookingEntry } },
      { session },
    );
    await session.commitTransaction();
    session.endSession();
    const saved = await Booking.findById(createdBooking._id).lean();
    return res.status(201).json({
      success: true,
      booking: saved,
    });
  } catch (error) {
    await session.abortTransaction().catch(() => {});
    session.endSession();
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getBooking = async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 12, 100);
    const search = req.query.search?.trim() || "";
    const status = req.query.status?.trim() || "";
    const carFilter = req.query.car?.trim() || "";
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const query = {};
    if (search) {
      const q = { $regex: search, $options: "i" };
      query.$or = [
        { customer: q },
        { email: q },
        { "car.make": q },
        { "car.model": q },
      ];
    }

    if (status) query.status = status;

    if (carFilter) {
      if (/^[0-9a-fA-F]{24}$/.test(carFilter)) query["car.id"] = carFilter;
      else
        query.$or = [
          ...(query.$or || []),
          { "car.make": { $regex: carFilter, $options: "i" } },
          { "car.model": { $regex: carFilter, $options: "i" } },
        ];
    }

    if (from || to) {
      query.pickupDate = {};
      if (from) query.pickupDate.$gte = from;
      if (to) query.pickupDate.$lte = to;
    }

    const total = await Booking.countDocuments(query);
    const bookings = await Booking.find(query)
      .sort({ bookingDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      page,
      pages: Math.ceil(total / limit),
      total,
      data: bookings,
    });
  } catch (error) {
    next(error);
  }
};

export const getMyBookings = async (req, res, next) => {
  try {
    if (!req.user || (!req.user.id && !req.user._id))
      return res.status(401).json({ message: "Unauthorized" });
    const userId = req.user.id || req.user._id;
    
    // Fetch bookings and populate car data
    const bookings = await Booking.find({ userId: userId })
      .sort({ bookingDate: -1 })
      .lean();
    
    // Populate missing car data by fetching from Car collection
    const populatedBookings = await Promise.all(
      bookings.map(async (booking) => {
        if (booking.car && booking.car.id && (!booking.car.make || !booking.car.model)) {
          try {
            const carData = await Car.findById(booking.car.id).lean();
            if (carData) {
              booking.car = {
                ...booking.car,
                make: carData.make || booking.car.make,
                model: carData.model || booking.car.model,
                year: carData.year || booking.car.year,
                image: carData.image || booking.car.image,
                category: carData.category || booking.car.category,
                seats: carData.seats || booking.car.seats,
                transmission: carData.transmission || booking.car.transmission,
                fuelType: carData.fuelType || booking.car.fuelType,
                mileage: carData.mileage || booking.car.mileage,
                dailyRate: carData.dailyRate || booking.car.dailyRate
              };
              
              // Ensure carImage is set from car data if not already present
              if (!booking.carImage && carData.image) {
                booking.carImage = carData.image;
              }
            }
          } catch (error) {
            console.error('Error fetching car data for booking:', booking._id, error);
          }
        }
        
        // Ensure carImage is available even if car data wasn't fetched
        if (!booking.carImage && booking.car?.image) {
          booking.carImage = booking.car.image;
        }
        
        return booking;
      })
    );
    
    res.json({
      success: true,
      data: populatedBookings
    });
  } catch (error) {
    console.error('getMyBookings error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
};

export const updateBooking = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (req.file) {
      if (booking.carImage && booking.carImage.startsWith("/uploads/"))
        deleteLocalFileIfPresent(booking.carImage);
      booking.carImage = `/uploads/${req.file.filename}`;
    } else if (req.body.carImage !== undefined) {
      if (
        req.body.carImage &&
        !String(req.body.carImage).startsWith("/uploads/") &&
        booking.carImage &&
        booking.carImage.startsWith("/uploads/")
      ) {
        deleteLocalFileIfPresent(booking.carImage);
      }
      booking.carImage = req.body.carImage || booking.carImage;
    }



    const updatable = [
      "customer",
      "email",
      "phone",
      "car",
      "pickupDate",
      "returnDate",
      "bookingDate",
      "status",
      "amount",
      "details",
      "address",
    ];
    for (const f of updatable) {
      if (req.body[f] === undefined) continue;
      if (["pickupDate", "returnDate", "bookingDate"].includes(f))
        booking[f] = new Date(req.body[f]);
      else if (f === "amount") booking[f] = Number(req.body[f]);
      else if (f === "details" || f === "address")
        booking[f] = tryParseJSON(req.body[f]);
      else if (f === "car") {
        const c = tryParseJSON(req.body.car);
        if (c) {
          const summary = buildCarSummary(c);
          if (!summary.id && booking.car?.id) summary.id = booking.car.id;
          booking.car = summary;
        }
      } else booking[f] = req.body[f];
    }

    const updated = await booking.save();
    res.json(updated);

  } catch (error) {
    next(error);    
  }
};

export const updateBookingStatus = async (req,res,next) => {
    try {
        const {status} =req.body;
        if(!status) return res.status(400).json({message:"Status is required"})
            const booking = await Booking.findById(req.params.id);
          if(!booking) return res.status(404).json({message:"Booking not found"})
            booking.status = status;
            const updated = await booking.save();
            res.json(updated);

    } 
    catch (error) {
        next(error);
    }
}


export const deleteBooking = async (req,res,next) =>{
    try {
       
    const booking = await Booking.findById(req.params.id);
    if(!booking) return res.status(404).json({message:"Booking not found"})
        if(booking.carImage && booking.carImage.startsWith("/uploads/")){
            deleteLocalFileIfPresent(booking.carImage)
        }

        await booking.remove()
        res.json({message:"Booking deleted successfully"})

    } 
    catch (error) {
    next(error)    
    }
}

