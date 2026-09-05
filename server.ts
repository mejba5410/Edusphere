import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { db } from './src/server/db';
import dotenv from 'dotenv';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Body parser middlewares
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Helper middleware for role and user resolution
  // We accept custom Authorization header 'Bearer <userId>' for simplicity and full-stack API capabilities
  const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized. No session found.' });
    }
    const userId = authHeader.split(' ')[1];
    const user = db.getUserById(userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found.' });
    }
    // Attach user to request for routing
    (req as any).user = user;
    next();
  };

  const roleCheck = (roles: string[]) => {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = (req as any).user;
      if (!user || !roles.includes(user.role)) {
        return res.status(403).json({ error: 'Forbidden. Access restricted.' });
      }
      next();
    };
  };

  // --- API ROUTES ---

  // Auth Endpoints
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const user = db.authenticate(email, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    res.json({ token: user.id, user });
  });

  app.post('/api/auth/register', (req, res) => {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: 'Missing required registration parameters.' });
    }
    const existing = db.getUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'User with this email already exists.' });
    }
    const newUser = db.createUser({
      email,
      name,
      role: role as any,
    }, password);
    res.json({ token: newUser.id, user: newUser });
  });

  app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json((req as any).user);
  });

  app.put('/api/auth/profile', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const { 
      name, bio, avatar, mobile, gender, dob, 
      division, district, upazila, address, education, profession 
    } = req.body;
    const updated = db.updateUser(user.id, { 
      name, bio, avatar, mobile, gender, dob, 
      division, district, upazila, address, education, profession 
    });
    res.json(updated);
  });

  app.post('/api/auth/wishlist/toggle', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const { courseId } = req.body;
    if (!courseId) {
      return res.status(400).json({ error: 'Missing courseId' });
    }
    const wishlist = db.toggleWishlist(user.id, courseId);
    res.json({ wishlist });
  });

  // Course Endpoints
  app.get('/api/courses', (req, res) => {
    let courses = db.getCourses();
    const { category, level, search, instructor, status } = req.query;

    if (category) {
      courses = courses.filter(c => c.categoryId === category);
    }
    if (level) {
      courses = courses.filter(c => c.level === level);
    }
    if (instructor) {
      courses = courses.filter(c => c.instructorId === instructor);
    }
    if (status && status !== 'all') {
      courses = courses.filter(c => c.status === status);
    } else if (!status) {
      // By default, public search only shows published courses
      courses = courses.filter(c => c.status === 'published');
    }
    if (search) {
      const query = (search as string).toLowerCase();
      courses = courses.filter(c => 
        c.title.toLowerCase().includes(query) || 
        c.description.toLowerCase().includes(query) ||
        c.instructorName.toLowerCase().includes(query)
      );
    }

    res.json(courses);
  });

  app.get('/api/courses/:id', (req, res) => {
    const course = db.getCourseById(req.params.id);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    res.json(course);
  });

  app.post('/api/courses', authMiddleware, roleCheck(['instructor', 'admin']), (req, res) => {
    const user = (req as any).user;
    const { 
      title, description, price, discountPrice, level, 
      language, categoryId, thumbnail, whatYouLearn, requirements, sections,
      instructorId, status
    } = req.body;

    if (!title || !description || !categoryId || !thumbnail) {
      return res.status(400).json({ error: 'Missing required course parameters.' });
    }

    const lessonsCount = sections ? sections.reduce((sum: number, s: any) => sum + (s.lessons ? s.lessons.length : 0), 0) : 0;
    const durationHours = Math.max(2, Math.ceil(lessonsCount * 1.5));
    const durationStr = `${durationHours} ঘণ্টা`;

    let finalInstructorId = user.id;
    let finalInstructorName = user.name;
    if (instructorId) {
      const inst = db.getUserById(instructorId);
      if (inst) {
        finalInstructorId = inst.id;
        finalInstructorName = inst.name;
      }
    }

    const newCourse = db.createCourse({
      title,
      description,
      instructorId: finalInstructorId,
      instructorName: finalInstructorName,
      price: Number(price) || 0,
      discountPrice: discountPrice ? Number(discountPrice) : undefined,
      level: level || 'Beginner',
      language: language || 'English',
      categoryId,
      status: status || 'published',
      thumbnail,
      duration: durationStr,
      lessonsCount,
      whatYouLearn: whatYouLearn || [],
      requirements: requirements || [],
      sections: sections || [],
    });

    res.status(201).json(newCourse);
  });

  app.put('/api/courses/:id', authMiddleware, roleCheck(['instructor', 'admin']), (req, res) => {
    const courseId = req.params.id;
    const existingCourse = db.getCourseById(courseId);
    if (!existingCourse) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const { 
      title, description, price, discountPrice, level, 
      language, categoryId, thumbnail, status, whatYouLearn, requirements, sections,
      instructorId
    } = req.body;

    const lessonsCount = sections ? sections.reduce((sum: number, s: any) => sum + (s.lessons ? s.lessons.length : 0), 0) : existingCourse.lessonsCount;
    const durationHours = Math.max(2, Math.ceil(lessonsCount * 1.5));
    const durationStr = `${durationHours} ঘণ্টা`;

    let finalInstructorId = existingCourse.instructorId;
    let finalInstructorName = existingCourse.instructorName;
    if (instructorId && instructorId !== existingCourse.instructorId) {
      const inst = db.getUserById(instructorId);
      if (inst) {
        finalInstructorId = inst.id;
        finalInstructorName = inst.name;
      }
    }

    const updated = db.updateCourse(courseId, {
      title,
      description,
      price: price !== undefined ? Number(price) : existingCourse.price,
      discountPrice: discountPrice !== undefined ? Number(discountPrice) : existingCourse.discountPrice,
      level: level || existingCourse.level,
      language: language || existingCourse.language,
      categoryId: categoryId || existingCourse.categoryId,
      status: status || existingCourse.status,
      thumbnail: thumbnail || existingCourse.thumbnail,
      duration: durationStr,
      lessonsCount,
      whatYouLearn: whatYouLearn || existingCourse.whatYouLearn,
      requirements: requirements || existingCourse.requirements,
      sections: sections || existingCourse.sections,
      instructorId: finalInstructorId,
      instructorName: finalInstructorName,
    });

    res.json(updated);
  });

  app.delete('/api/courses/:id', authMiddleware, roleCheck(['instructor', 'admin']), (req, res) => {
    const success = db.deleteCourse(req.params.id);
    if (!success) {
      return res.status(404).json({ error: 'Course not found' });
    }
    res.json({ message: 'Course deleted successfully' });
  });

  // Category Endpoints
  app.get('/api/categories', (req, res) => {
    res.json(db.getCategories());
  });

  // Enrollment & Purchases Endpoints
  app.get('/api/enrollments/me', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const enrollments = db.getEnrollmentsByStudent(user.id);
    
    // Map course details onto enrollments
    const results = enrollments.map(e => {
      const course = db.getCourseById(e.courseId);
      return {
        ...e,
        course
      };
    });
    res.json(results);
  });

  app.post('/api/courses/:id/enroll', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const courseId = req.params.id;
    const { amount, couponCode } = req.body;

    try {
      const course = db.getCourseById(courseId);
      if (!course) {
        return res.status(404).json({ error: 'কোর্সটি খুঁজে পাওয়া যায়নি।' });
      }

      let expectedPrice = course.discountPrice !== undefined && course.discountPrice !== null ? course.discountPrice : course.price;

      if (couponCode) {
        const coupon = db.getCouponByCode(couponCode.trim());
        if (!coupon) {
          return res.status(400).json({ error: 'ভুল বা অবৈধ কুপন কোড।' });
        }
        
        if (coupon.status !== 'active') {
          return res.status(400).json({ error: 'এই কুপনটি বর্তমানে সক্রিয় নেই।' });
        }
        const todayStr = new Date().toISOString().split('T')[0];
        if (coupon.startDate && todayStr < coupon.startDate) {
          return res.status(400).json({ error: 'এই কুপনটি এখনও শুরু হয়নি।' });
        }
        if (coupon.expiryDate && todayStr > coupon.expiryDate) {
          return res.status(400).json({ error: 'দুঃখিত, কুপনটির মেয়াদ শেষ হয়ে গেছে।' });
        }
        if (coupon.usageLimit !== undefined && coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
          return res.status(400).json({ error: 'এই কুপনটির ব্যবহারের সর্বোচ্চ সীমা পার হয়ে গেছে।' });
        }
        if (coupon.perUserLimit) {
          const userUsages = db.getCouponUsagesByUser(user.id).filter(cu => cu.couponId === coupon.id && cu.courseId === courseId);
          if (userUsages.length >= coupon.perUserLimit) {
            return res.status(400).json({ error: 'আপনি ইতিমধ্যেই এই কুপনটি ব্যবহার করেছেন।' });
          }
        }
        if (coupon.minPurchase && expectedPrice < coupon.minPurchase) {
          return res.status(400).json({ error: `এই কুপনটি ব্যবহারের জন্য নূন্যতম ৳${coupon.minPurchase} সমমূল্যের কোর্স কেনা আবশ্যক।` });
        }
        if (coupon.appliesTo === 'specific_courses' && (!coupon.applicableCourseIds || !coupon.applicableCourseIds.includes(courseId))) {
          return res.status(400).json({ error: 'এই কুপনটি এই কোর্সের জন্য প্রযোজ্য নয়।' });
        }
        if (coupon.appliesTo === 'specific_categories' && (!coupon.applicableCategoryIds || !coupon.applicableCategoryIds.includes(course.categoryId))) {
          return res.status(400).json({ error: 'এই কুপনটি এই ক্যাটাগরির কোর্সের জন্য প্রযোজ্য নয়।' });
        }
        if (coupon.instructorId && coupon.instructorId !== course.instructorId) {
          return res.status(400).json({ error: 'এই কুপনটি এই ইন্সট্রাক্টরের কোর্সের জন্য প্রযোজ্য নয়।' });
        }

        let discount = 0;
        if (coupon.discountType === 'percentage') {
          discount = Math.round((expectedPrice * coupon.discountValue) / 100);
          if (coupon.maxDiscount) {
            discount = Math.min(discount, coupon.maxDiscount);
          }
        } else {
          discount = Math.min(coupon.discountValue, expectedPrice);
        }
        expectedPrice = Math.max(0, expectedPrice - discount);
      }

      // Record enrollment with the server-recalculated final amount
      const result = db.enrollStudent(user.id, courseId, expectedPrice, couponCode);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/enrollments/:courseId/lessons/:lessonId/complete', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const { courseId, lessonId } = req.params;
    const { completed } = req.body;

    const enrollment = db.updateLessonProgress(user.id, courseId, lessonId, completed);
    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment record not found' });
    }
    res.json(enrollment);
  });

  // Quiz Endpoints
  app.get('/api/courses/:courseId/quiz', (req, res) => {
    const quiz = db.getQuizByCourseId(req.params.courseId);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found for this course' });
    }
    res.json(quiz);
  });

  app.post('/api/courses/:courseId/quiz', authMiddleware, roleCheck(['instructor', 'admin']), (req, res) => {
    const { courseId } = req.params;
    const { title, questions } = req.body;
    if (!title || !questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Quiz title and questions array are required' });
    }
    const quiz = db.createQuiz(courseId, title, questions);
    res.status(201).json(quiz);
  });

  app.post('/api/quizzes/submit', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const { quizId, answers, score, maxScore, passed, quizTitle, courseTitle } = req.body;

    if (!quizId || score === undefined || maxScore === undefined) {
      return res.status(400).json({ error: 'Missing quiz submission payload' });
    }

    const attempt = db.submitQuizAttempt({
      quizId,
      quizTitle,
      courseTitle,
      studentId: user.id,
      score,
      maxScore,
      passed,
      answers
    });

    res.json(attempt);
  });

  app.get('/api/quizzes/attempts/me', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const attempts = db.getQuizAttempts().filter(a => a.studentId === user.id);
    res.json(attempts);
  });

  // Assignment Endpoints
  app.get('/api/courses/:courseId/assignment', (req, res) => {
    const assignment = db.getAssignmentByCourseId(req.params.courseId);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found for this course' });
    }
    res.json(assignment);
  });

  app.post('/api/courses/:courseId/assignment', authMiddleware, roleCheck(['instructor', 'admin']), (req, res) => {
    const { courseId } = req.params;
    const { title, description, maxScore } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'Assignment title and description are required' });
    }
    const assignment = db.createAssignment(courseId, title, description, Number(maxScore) || 100);
    res.status(201).json(assignment);
  });

  app.get('/api/assignments/submissions/me', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const subs = db.getAssignmentSubmissions().filter(s => s.studentId === user.id);
    res.json(subs);
  });

  app.post('/api/assignments/submit', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const { assignmentId, assignmentTitle, courseTitle, submissionUrl } = req.body;

    if (!assignmentId || !submissionUrl) {
      return res.status(400).json({ error: 'Assignment ID and submission link/file are required.' });
    }

    const submission = db.submitAssignment({
      assignmentId,
      assignmentTitle,
      courseTitle,
      studentId: user.id,
      studentName: user.name,
      submissionUrl
    });

    res.status(201).json(submission);
  });

  app.get('/api/assignments/submissions/instructor', authMiddleware, roleCheck(['instructor', 'admin']), (req, res) => {
    const user = (req as any).user;
    const courses = db.getCourses().filter(c => c.instructorId === user.id);
    const courseIds = courses.map(c => c.id);
    
    // Get assignments for instructor courses
    const assignments = db.getAssignments().filter(a => courseIds.includes(a.courseId));
    const assignmentIds = assignments.map(a => a.id);

    const submissions = db.getAssignmentSubmissions().filter(s => assignmentIds.includes(s.assignmentId));
    res.json(submissions);
  });

  app.post('/api/assignments/submissions/:id/grade', authMiddleware, roleCheck(['instructor', 'admin']), (req, res) => {
    const subId = req.params.id;
    const { grade, feedback } = req.body;
    const user = (req as any).user;

    if (grade === undefined || !feedback) {
      return res.status(400).json({ error: 'Grade and feedback comments are required.' });
    }

    const graded = db.gradeSubmission(subId, Number(grade), feedback, user.id);
    if (!graded) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    res.json(graded);
  });

  // Review Endpoints
  app.get('/api/courses/:courseId/reviews', (req, res) => {
    const reviews = db.getReviews().filter(r => r.courseId === req.params.courseId);
    res.json(reviews);
  });

  app.post('/api/courses/:courseId/reviews', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const courseId = req.params.id;
    const { rating, comment, courseTitle } = req.body;

    if (!rating || !comment) {
      return res.status(400).json({ error: 'Rating and comment are required.' });
    }

    const newReview = db.addReview({
      courseId,
      courseTitle: courseTitle || 'Online Course',
      studentId: user.id,
      studentName: user.name,
      studentAvatar: user.avatar,
      rating: Number(rating),
      comment
    });

    res.status(201).json(newReview);
  });

  // Payment Endpoints
  app.get('/api/payments/me', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const payments = db.getPayments().filter(p => p.studentId === user.id);
    res.json(payments);
  });

  app.get('/api/payments/all', authMiddleware, roleCheck(['admin']), (req, res) => {
    res.json(db.getPayments());
  });

  // --- Coupon Endpoints ---

  app.get('/api/admin/coupons', authMiddleware, roleCheck(['admin']), (req, res) => {
    res.json(db.getCoupons());
  });

  app.get('/api/admin/coupons/stats', authMiddleware, roleCheck(['admin']), (req, res) => {
    try {
      const usages = db.getCouponUsages();
      const coupons = db.getCoupons();
      
      let mostUsedCoupon: any = null;
      let maxUsed = 0;
      coupons.forEach(c => {
        if (c.usedCount > maxUsed) {
          maxUsed = c.usedCount;
          mostUsedCoupon = c;
        }
      });

      res.json({
        totalCoupons: coupons.length,
        activeCoupons: coupons.filter(c => c.status === 'active').length,
        totalDiscountGiven: usages.reduce((sum, u) => sum + u.discountAmount, 0),
        totalUsages: usages.length,
        recentUsages: usages.slice(-15).reverse(),
        mostUsedCoupon
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/coupons', authMiddleware, roleCheck(['admin']), (req, res) => {
    try {
      const {
        code, description, discountType, discountValue, maxDiscount,
        minPurchase, startDate, expiryDate, usageLimit, perUserLimit,
        status, appliesTo, applicableCourseIds, applicableCategoryIds, instructorId
      } = req.body;

      if (!code || !discountType || discountValue === undefined || !startDate || !expiryDate) {
        return res.status(400).json({ error: 'প্রয়োজনীয় ফিল্ডগুলো পূরণ করুন।' });
      }

      const newCoupon = db.createCoupon({
        code: code.toUpperCase().trim(),
        description,
        discountType,
        discountValue: Number(discountValue),
        maxDiscount: maxDiscount ? Number(maxDiscount) : undefined,
        minPurchase: minPurchase ? Number(minPurchase) : undefined,
        startDate,
        expiryDate,
        usageLimit: usageLimit ? Number(usageLimit) : undefined,
        perUserLimit: perUserLimit ? Number(perUserLimit) : undefined,
        status: status || 'active',
        appliesTo: appliesTo || 'all',
        applicableCourseIds,
        applicableCategoryIds,
        instructorId
      });

      res.status(201).json(newCoupon);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/admin/coupons/:id', authMiddleware, roleCheck(['admin']), (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Clean updates values
      if (updates.discountValue !== undefined) updates.discountValue = Number(updates.discountValue);
      if (updates.maxDiscount !== undefined) updates.maxDiscount = updates.maxDiscount ? Number(updates.maxDiscount) : undefined;
      if (updates.minPurchase !== undefined) updates.minPurchase = updates.minPurchase ? Number(updates.minPurchase) : undefined;
      if (updates.usageLimit !== undefined) updates.usageLimit = updates.usageLimit ? Number(updates.usageLimit) : undefined;
      if (updates.perUserLimit !== undefined) updates.perUserLimit = updates.perUserLimit ? Number(updates.perUserLimit) : undefined;

      const updated = db.updateCoupon(id, updates);
      if (!updated) {
        return res.status(404).json({ error: 'কুপনটি পাওয়া যায়নি।' });
      }
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/coupons/:id', authMiddleware, roleCheck(['admin']), (req, res) => {
    try {
      const { id } = req.params;
      const success = db.deleteCoupon(id);
      if (!success) {
        return res.status(404).json({ error: 'কুপনটি পাওয়া যায়নি।' });
      }
      res.json({ success: true, message: 'কুপনটি সফলভাবে মুছে ফেলা হয়েছে।' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/coupons/validate', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const { code, courseId } = req.body;

    if (!code || !courseId) {
      return res.status(400).json({ error: 'কুপন কোড এবং কোর্স আইডি প্রয়োজন।' });
    }

    const course = db.getCourseById(courseId);
    if (!course) {
      return res.status(404).json({ error: 'কোর্সটি খুঁজে পাওয়া যায়নি।' });
    }

    const coupon = db.getCouponByCode(code.trim());
    if (!coupon) {
      return res.status(400).json({ error: 'ভুল বা অবৈধ কুপন কোড।' });
    }

    // 1. Status check
    if (coupon.status !== 'active') {
      return res.status(400).json({ error: 'এই কুপনটি বর্তমানে সচল নেই।' });
    }

    // 2. Dates check
    const todayStr = new Date().toISOString().split('T')[0];
    if (coupon.startDate && todayStr < coupon.startDate) {
      return res.status(400).json({ error: 'এই কুপনটি এখনও শুরু হয়নি।' });
    }
    if (coupon.expiryDate && todayStr > coupon.expiryDate) {
      return res.status(400).json({ error: 'দুঃখিত, কুপনটির মেয়াদ শেষ হয়ে গেছে।' });
    }

    // 3. Total usage limit
    if (coupon.usageLimit !== undefined && coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
      return res.status(400).json({ error: 'এই কুপনটির ব্যবহারের সর্বোচ্চ সীমা পার হয়ে গেছে।' });
    }

    // 4. Per user limit
    if (coupon.perUserLimit) {
      const userUsages = db.getCouponUsagesByUser(user.id).filter(cu => cu.couponId === coupon.id && cu.courseId === courseId);
      if (userUsages.length >= coupon.perUserLimit) {
        return res.status(400).json({ error: 'আপনি ইতিমধ্যেই এই কুপনটি ব্যবহার করেছেন।' });
      }
    }

    // 5. Minimum purchase
    const originalPrice = course.discountPrice !== undefined && course.discountPrice !== null ? course.discountPrice : course.price;
    if (coupon.minPurchase && originalPrice < coupon.minPurchase) {
      return res.status(400).json({ error: `এই কুপনটি ব্যবহারের জন্য নূন্যতম ৳${coupon.minPurchase} সমমূল্যের কোর্স কেনা আবশ্যক।` });
    }

    // 6. Applies to check (specific courses or categories)
    if (coupon.appliesTo === 'specific_courses') {
      if (!coupon.applicableCourseIds || !coupon.applicableCourseIds.includes(courseId)) {
        return res.status(400).json({ error: 'এই কুপনটি এই কোর্সের জন্য প্রযোজ্য নয়।' });
      }
    } else if (coupon.appliesTo === 'specific_categories') {
      if (!coupon.applicableCategoryIds || !coupon.applicableCategoryIds.includes(course.categoryId)) {
        return res.status(400).json({ error: 'এই কুপনটি এই ক্যাটাগরির কোর্সের জন্য প্রযোজ্য নয়।' });
      }
    }

    // 7. Instructor check
    if (coupon.instructorId && coupon.instructorId !== course.instructorId) {
      return res.status(400).json({ error: 'এই কুপনটি এই ইন্সট্রাক্টরের কোর্সের জন্য প্রযোজ্য নয়।' });
    }

    // Calculate discount
    let discount = 0;
    if (coupon.discountType === 'percentage') {
      discount = Math.round((originalPrice * coupon.discountValue) / 100);
      if (coupon.maxDiscount) {
        discount = Math.min(discount, coupon.maxDiscount);
      }
    } else {
      discount = Math.min(coupon.discountValue, originalPrice);
    }

    const finalPrice = Math.max(0, originalPrice - discount);

    res.json({
      valid: true,
      coupon,
      discountAmount: discount,
      originalPrice,
      finalPrice
    });
  });

  // Coupon Endpoint
  app.get('/api/coupons/:code', (req, res) => {
    const coupon = db.getCouponByCode(req.params.code);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found or expired.' });
    }
    res.json(coupon);
  });

  // Certificate Verification (No auth required)
  app.get('/api/certificates/:id', (req, res) => {
    const cert = db.getCertificateById(req.params.id);
    if (!cert) {
      return res.status(404).json({ error: 'Certificate not found or invalid' });
    }
    res.json(cert);
  });

  app.get('/api/certificates/me', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const certs = db.getCertificates().filter(c => c.studentId === user.id);
    res.json(certs);
  });

  // Notification Endpoints
  app.get('/api/notifications/me', authMiddleware, (req, res) => {
    const user = (req as any).user;
    res.json(db.getNotifications(user.id));
  });

  app.post('/api/notifications/:id/read', authMiddleware, (req, res) => {
    const success = db.markNotificationRead(req.params.id);
    res.json({ success });
  });

  app.post('/api/notifications/read-all', authMiddleware, (req, res) => {
    const user = (req as any).user;
    db.markAllNotificationsRead(user.id);
    res.json({ success: true });
  });

  // Messaging Endpoints
  app.get('/api/messages', authMiddleware, (req, res) => {
    const user = (req as any).user;
    res.json(db.getMessages(user.id));
  });

  app.post('/api/messages', authMiddleware, (req, res) => {
    const user = (req as any).user;
    const { receiverId, content } = req.body;
    if (!receiverId || !content) {
      return res.status(400).json({ error: 'Receiver ID and content are required.' });
    }
    const msg = db.sendMessage(user.id, receiverId, content);
    res.status(201).json(msg);
  });

  // Instructor Stats Endpoint
  app.get('/api/instructor/stats', authMiddleware, roleCheck(['instructor', 'admin']), (req, res) => {
    const user = (req as any).user;
    const courses = db.getCourses().filter(c => c.instructorId === user.id);
    const courseIds = courses.map(c => c.id);

    const totalCourses = courses.length;
    const publishedCourses = courses.filter(c => c.status === 'published').length;
    
    // Total students (sum of enrolled students unique count or raw counts)
    const enrollments = db.getEnrollments().filter(e => courseIds.includes(e.courseId));
    const totalStudents = enrollments.length;

    // Total revenue
    const payments = db.getPayments().filter(p => courseIds.includes(p.courseId));
    const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);

    // Reviews analytics
    const reviews = db.getReviews().filter(r => courseIds.includes(r.courseId));
    const avgRating = reviews.length > 0 ? parseFloat((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)) : 5.0;

    res.json({
      totalCourses,
      publishedCourses,
      totalStudents,
      totalRevenue,
      averageRating: avgRating,
      courses,
      reviews,
      payments
    });
  });

  // Admin Analytics Endpoint
  app.get('/api/admin/analytics', authMiddleware, roleCheck(['admin']), (req, res) => {
    const users = db.getUsers();
    const courses = db.getCourses();
    const enrollments = db.getEnrollments();
    const payments = db.getPayments();
    const reviews = db.getReviews();
    const certificates = db.getCertificates();

    const totalUsers = users.length;
    const totalStudents = users.filter(u => u.role === 'student').length;
    const totalInstructors = users.filter(u => u.role === 'instructor').length;
    const totalCourses = courses.length;
    const publishedCourses = courses.filter(c => c.status === 'published').length;
    const pendingCourses = courses.filter(c => c.status === 'draft').length;
    const totalEnrollments = enrollments.length;
    const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);

    res.json({
      summary: {
        totalUsers,
        totalStudents,
        totalInstructors,
        totalCourses,
        publishedCourses,
        pendingCourses,
        totalEnrollments,
        totalRevenue,
        totalCertificates: certificates.length,
        totalReviews: reviews.length
      },
      recentRegistrations: users.slice(-5).reverse(),
      recentEnrollments: enrollments.slice(-5).reverse().map(e => {
        const student = db.getUserById(e.studentId);
        const course = db.getCourseById(e.courseId);
        return {
          ...e,
          studentName: student?.name || 'Unknown',
          courseTitle: course?.title || 'Unknown'
        };
      }),
      recentPayments: payments.slice(-5).reverse(),
      coursePerformance: courses.map(c => ({
        id: c.id,
        title: c.title,
        studentsCount: c.studentsCount,
        rating: c.rating,
        revenue: payments.filter(p => p.courseId === c.id).reduce((sum, p) => sum + p.amount, 0)
      })).sort((a, b) => b.studentsCount - a.studentsCount),
    });
  });

  // Admin CRUD for Users, Courses, Certificates etc
  app.get('/api/admin/users', authMiddleware, roleCheck(['admin']), (req, res) => {
    res.json(db.getUsers());
  });

  app.put('/api/admin/users/:id/role', authMiddleware, roleCheck(['admin']), (req, res) => {
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: 'Role required' });
    const updated = db.updateUserRole(req.params.id, role);
    res.json(updated);
  });

  app.delete('/api/admin/users/:id', authMiddleware, roleCheck(['admin']), (req, res) => {
    // Admin can delete user
    const users = db.getUsers();
    const index = users.findIndex(u => u.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'User not found' });
    users.splice(index, 1);
    res.json({ success: true });
  });

  // --- VITE DEV AND PROD MIDDLEWARE SETUP ---

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
