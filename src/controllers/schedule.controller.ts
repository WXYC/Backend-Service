import { Request, RequestHandler } from "express";
import * as ScheduleService from "../services/schedule.service";
import { NewShift } from "../db/schema";

export const getSchedule: RequestHandler<object, unknown, object, object> = async (req, res, next) => {
  try {
    const schedule = await ScheduleService.getSchedule();
    res.status(200).json(schedule);
  } catch (e) {
    console.error('Error getting schedule');
    console.error(e);
    next(e);
  }
};


export const addToSchedule: RequestHandler = async (req: Request<object, object, NewShift>, res, next) => {
    const { body } = req;
    try {
        let response = await ScheduleService.addToSchedule(body);
        res.status(200).json(response);
    } catch (e) {
        console.error('Error adding to schedule');
        console.error(e);
        next(e);
    }
}
/*
export const removeFromSchedule: RequestHandler<object, unknown, object, { show_id: number }> = async (req, res, next) => {
    if (req.query.show_id === undefined) {
        console.error('Bad Request, Missing Show Identifier: show_id');
        res.status(400).send('Bad Request, Missing Show Identifier: show_id');
    } else {
        try {
        const removed_show = await ScheduleService.removeFromSchedule(req.query.show_id);
        res.status(200).json(removed_show);
        } catch (e) {
        console.error(e);
        next(e);
        }
    }
};

export const addToSchedule: RequestHandler<object, unknown, object, { show_id: number }> = async (req, res, next) => {
    if (req.query.show_id === undefined) {
        console.error('Bad Request, Missing Show Identifier: show_id');
        res.status(400).send('Bad Request, Missing Show Identifier: show_id');
    } else {
        try {
        const added_show = await ScheduleService.addToSchedule(req.query.show_id);
        res.status(200).json(added_show);
        } catch (e) {
        console.error(e);
        next(e);
        }
    }
};

export const updateSchedule: RequestHandler<object, unknown, object, { show_id: number, start_time: string, end_time: string }> = async (req, res, next) => {
    if (req.query.show_id === undefined) {
        console.error('Bad Request, Missing Show Identifier: show_id');
        res.status(400).send('Bad Request, Missing Show Identifier: show_id');
    } else {
        try {
        const updated_show = await ScheduleService.updateSchedule(req.query.show_id, req.query.start_time, req.query.end_time);
        res.status(200).json(updated_show);
        } catch (e) {
        console.error(e);
        next(e);
        }
    }
};
*/
