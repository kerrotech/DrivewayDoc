const fs = require("fs/promises");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");

async function readDb() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.vehicles || !Array.isArray(parsed.vehicles)) {
      parsed.vehicles = [];
    }
    if (!parsed.customers || !Array.isArray(parsed.customers)) {
      parsed.customers = [];
    }
    for (const vehicle of parsed.vehicles) {
      if (!Array.isArray(vehicle.services)) {
        vehicle.services = [];
      }
      if (!Array.isArray(vehicle.parts)) {
        vehicle.parts = [];
      }
      if (!Array.isArray(vehicle.scheduledMaintenance)) {
        vehicle.scheduledMaintenance = [];
      }
      if (typeof vehicle.customerId !== "string") {
        vehicle.customerId = "";
      }
      if (typeof vehicle.currentHours === "undefined") {
        vehicle.currentHours = 0;
      }
      if (typeof vehicle.isMyVehicle !== "boolean") {
        vehicle.isMyVehicle = !vehicle.customerId;
      }
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { vehicles: [], customers: [] };
    }
    throw error;
  }
}

async function writeDb(data) {
  await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), "utf8");
}

function withCustomer(vehicle, customerMap) {
  const customer = vehicle.customerId ? customerMap.get(vehicle.customerId) || null : null;
  return {
    ...vehicle,
    customer
  };
}

async function getCustomers(userId) {
  const db = await readDb();
  return db.customers
    .filter((c) => c.userId === userId)
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
}

async function getCustomerById(id, userId) {
  const db = await readDb();
  return db.customers.find((c) => c.id === id && c.userId === userId) || null;
}

async function addCustomer(customer) {
  const db = await readDb();
  db.customers.push(customer);
  await writeDb(db);
  return customer;
}

async function updateCustomer(id, nextData, userId) {
  const db = await readDb();
  const index = db.customers.findIndex((c) => c.id === id && c.userId === userId);
  if (index === -1) return null;

  const updated = {
    ...db.customers[index],
    ...nextData,
    id,
    updatedAt: new Date().toISOString()
  };

  db.customers[index] = updated;
  await writeDb(db);
  return updated;
}

async function deleteCustomer(id, userId) {
  const db = await readDb();
  const before = db.customers.length;
  db.customers = db.customers.filter((c) => !(c.id === id && c.userId === userId));
  if (db.customers.length === before) return false;
  await writeDb(db);
  return true;
}

async function getVehicles(userId) {
  const db = await readDb();
  const customerMap = new Map(
    db.customers.filter((c) => c.userId === userId).map((c) => [c.id, c])
  );
  return db.vehicles
    .filter((v) => v.userId === userId)
    .sort((a, b) => `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`))
    .map((vehicle) => withCustomer(vehicle, customerMap));
}

async function getVehicleById(id, userId) {
  const db = await readDb();
  const vehicle = db.vehicles.find((v) => v.id === id && v.userId === userId) || null;
  if (!vehicle) return null;
  const customerMap = new Map(
    db.customers.filter((c) => c.userId === userId).map((c) => [c.id, c])
  );
  return withCustomer(vehicle, customerMap);
}

async function getVehiclesByCustomer(customerId, userId) {
  const db = await readDb();
  return db.vehicles
    .filter((v) => v.customerId === customerId && v.userId === userId)
    .sort((a, b) => `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`));
}

async function addVehicle(vehicle) {
  const db = await readDb();
  db.vehicles.push(vehicle);
  await writeDb(db);
  return vehicle;
}

async function updateVehicle(id, nextData, userId) {
  const db = await readDb();
  const index = db.vehicles.findIndex((v) => v.id === id && v.userId === userId);
  if (index === -1) return null;

  const updated = {
    ...db.vehicles[index],
    ...nextData,
    id,
    services: db.vehicles[index].services || [],
    parts: db.vehicles[index].parts || [],
    scheduledMaintenance: db.vehicles[index].scheduledMaintenance || [],
    updatedAt: new Date().toISOString()
  };

  db.vehicles[index] = updated;
  await writeDb(db);
  return updated;
}

  function getLastServiceByType(vehicle, serviceType) {
    if (!Array.isArray(vehicle.services)) return null;
    const sorted = [...vehicle.services].sort((a, b) => new Date(b.date) - new Date(a.date));
    return sorted.find((s) => s.serviceType === serviceType) || null;
  }
  
  function calculateDueServices(vehicle) {
    if (!Array.isArray(vehicle.scheduledMaintenance)) return [];
    
    return vehicle.scheduledMaintenance.map((interval) => {
      const lastService = getLastServiceByType(vehicle, interval.type);
      let dueMileage = null;
      let dueStatus = "No Record";
      
      if (lastService) {
        dueMileage = lastService.mileage + interval.interval;
        dueStatus = vehicle.currentMileage >= dueMileage ? "OVERDUE" : `Due at ${dueMileage.toLocaleString()} mi`;
      }
      
      return {
        ...interval,
        dueMileage,
        dueStatus,
        lastServiceDate: lastService ? lastService.date : null
      };
    });
  }
async function deleteVehicle(id, userId) {
  const db = await readDb();
  const before = db.vehicles.length;
  db.vehicles = db.vehicles.filter((v) => !(v.id === id && v.userId === userId));
  if (db.vehicles.length === before) return false;
  await writeDb(db);
  return true;
}

async function addServiceRecord(vehicleId, record, userId) {
  const db = await readDb();
  const vehicle = db.vehicles.find((v) => v.id === vehicleId && v.userId === userId);
  if (!vehicle) return null;

  if (!Array.isArray(vehicle.services)) {
    vehicle.services = [];
  }

  vehicle.services.push(record);
  vehicle.services.sort((a, b) => (a.date < b.date ? 1 : -1));
  vehicle.updatedAt = new Date().toISOString();

  if (Number.isFinite(record.mileage) && record.mileage > (vehicle.currentMileage || 0)) {
    vehicle.currentMileage = record.mileage;
  }

  if (Number.isFinite(record.hours) && record.hours > (vehicle.currentHours || 0)) {
    vehicle.currentHours = record.hours;
  }

  await writeDb(db);
  return record;
}

async function deleteServiceRecord(vehicleId, recordId, userId) {
  const db = await readDb();
  const vehicle = db.vehicles.find((v) => v.id === vehicleId && v.userId === userId);
  if (!vehicle || !Array.isArray(vehicle.services)) return false;

  const before = vehicle.services.length;
  vehicle.services = vehicle.services.filter((record) => record.id !== recordId);
  if (vehicle.services.length === before) return false;

  vehicle.updatedAt = new Date().toISOString();
  await writeDb(db);
  return true;
}

async function addPart(vehicleId, part, userId) {
  const db = await readDb();
  const vehicle = db.vehicles.find((v) => v.id === vehicleId && v.userId === userId);
  if (!vehicle) return null;

  if (!Array.isArray(vehicle.parts)) {
    vehicle.parts = [];
  }

  vehicle.parts.push(part);
  vehicle.updatedAt = new Date().toISOString();
  await writeDb(db);
  return part;
}

async function deletePart(vehicleId, partId, userId) {
  const db = await readDb();
  const vehicle = db.vehicles.find((v) => v.id === vehicleId && v.userId === userId);
  if (!vehicle || !Array.isArray(vehicle.parts)) return false;

  const before = vehicle.parts.length;
  vehicle.parts = vehicle.parts.filter((part) => part.id !== partId);
  if (vehicle.parts.length === before) return false;

  vehicle.updatedAt = new Date().toISOString();
  await writeDb(db);
  return true;
}

async function addScheduledMaintenance(vehicleId, maintenance, userId) {
  const db = await readDb();
  const vehicle = db.vehicles.find((v) => v.id === vehicleId && v.userId === userId);
  if (!vehicle) return null;

  if (!Array.isArray(vehicle.scheduledMaintenance)) {
    vehicle.scheduledMaintenance = [];
  }

  vehicle.scheduledMaintenance.push(maintenance);
  vehicle.updatedAt = new Date().toISOString();
  await writeDb(db);
  return maintenance;
}

async function deleteScheduledMaintenance(vehicleId, maintenanceId, userId) {
  const db = await readDb();
  const vehicle = db.vehicles.find((v) => v.id === vehicleId && v.userId === userId);
  if (!vehicle || !Array.isArray(vehicle.scheduledMaintenance)) return false;

  const before = vehicle.scheduledMaintenance.length;
  vehicle.scheduledMaintenance = vehicle.scheduledMaintenance.filter((m) => m.id !== maintenanceId);
  if (vehicle.scheduledMaintenance.length === before) return false;

  vehicle.updatedAt = new Date().toISOString();
  await writeDb(db);
  return true;
}

module.exports = {
  getCustomers,
  getCustomerById,
  addCustomer,
  updateCustomer,
  deleteCustomer,
  getVehicles,
  getVehicleById,
  getVehiclesByCustomer,
  addVehicle,
  updateVehicle,
  deleteVehicle,
  addServiceRecord,
  deleteServiceRecord,
  addPart,
  deletePart,
  addScheduledMaintenance,
  deleteScheduledMaintenance,
  calculateDueServices,
  getLastServiceByType
};
