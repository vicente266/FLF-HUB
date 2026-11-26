/** `crm:events.upcoming`: the next days of the Calendar connection, read live (not stored). */

export interface UpcomingAttendee {
	email: string;
	name: string | null;
	/** The CRM contact with this email, when there is one. */
	contactId: string | null;
	contactName: string | null;
}

export interface UpcomingMeeting {
	id: string;
	calendarId: string;
	title: string;
	/** ISO date-time, or YYYY-MM-DD for an all-day event. */
	start: string;
	end: string;
	allDay: boolean;
	location: string | null;
	meetLink: string | null;
	attendees: UpcomingAttendee[];
}

export interface Upcoming {
	/** False until Connections → Calendar has a calendar id. */
	configured: boolean;
	days: number;
	meetings: UpcomingMeeting[];
	errors: { calendarId: string; message: string }[];
}
